import crypto from 'crypto'
import * as GoogleGeminiClientModule from './GoogleGeminiClient.js'
import { newFetch } from '../utils/proxy.js'
import _ from 'lodash'
import { Config } from '../utils/config.js'
// import { logger } from '../utils/logger.js'

const BASEURL = 'https://generativelanguage.googleapis.com'

export const HarmCategory = {
  HARM_CATEGORY_UNSPECIFIED: 'HARM_CATEGORY_UNSPECIFIED',
  HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
  HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
  HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
  HARM_CATEGORY_CIVIC_INTEGRITY: 'HARM_CATEGORY_CIVIC_INTEGRITY'
}

export const HarmBlockThreshold = {
  HARM_BLOCK_THRESHOLD_UNSPECIFIED: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
  BLOCK_LOW_AND_ABOVE: 'BLOCK_LOW_AND_ABOVE',
  BLOCK_MEDIUM_AND_ABOVE: 'BLOCK_MEDIUM_AND_ABOVE',
  BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
  BLOCK_NONE: 'BLOCK_NONE',
  OFF: 'OFF'
}

/**
 * @typedef {{
 *   role: string,
 *   parts: Array<{
 *     text?: string,
 *     functionCall?: FunctionCall,
 *     functionResponse?: FunctionResponse,
 *     executableCode?: {
 *       language: string,
 *       code: string
 *     },
 *     codeExecutionResult?: {
 *       outcome: string,
 *       output: string
 *     }
 *   }>
 * }} Content
 *
 * Gemini消息的基本格式
 */

/**
 * @typedef {{
 *   searchEntryPoint: {
 *     renderedContent: string,
 *   },
 *   groundingChunks: Array<{
 *     web: {
 *       uri: string,
 *       title: string
 *     }
 *   }>,
 *   webSearchQueries: Array<string>
 * }} GroundingMetadata
 * 搜索结果的元数据
 */

/**
 * @typedef {{
 *    name: string,
 *    args: {}
 * }} FunctionCall
 *
 * Gemini的FunctionCall
 */

/**
 * @typedef {{
 *   name: string,
 *   response: {
 *     name: string,
 *     content: {}
 *   }
 * }} FunctionResponse
 *
 * Gemini的Function执行结果包裹
 * 其中response可以为任意，本项目根据官方示例封装为name和content两个字段
 */

export class CustomGoogleGeminiClient extends GoogleGeminiClientModule.GoogleGeminiClient {
  constructor (props) {
    super(props)
    this.model = props.model
    this.baseUrl = props.baseUrl || BASEURL
    this.supportFunction = true
    this.debug = props.debug
    if (Array.isArray(props.key)) {
      this._keys = props.key;
      this._keyIndex = 0;
      this._key = this._keys[this._keyIndex];
    }
  }

  /**
   *
   * @param text
   * @param {{
   *     conversationId: string?,
   *     parentMessageId: string?,
   *     stream: boolean?,
   *     onProgress: function?,
   *     functionResponse?: FunctionResponse | FunctionResponse[],
   *     system: string?,
   *     image: string?,
   *     maxOutputTokens: number?,
   *     temperature: number?,
   *     topP: number?,
   *     tokK: number?,
   *     replyPureTextCallback: Function,
   *     toolMode: 'AUTO' | 'ANY' | 'NONE'
   *     search: boolean,
   *     codeExecution: boolean,
   * }} opt
   * @param {number} retryTime 重试次数
   * @returns {Promise<{conversationId: string?, parentMessageId: string, text: string, id: string}>}
   */
  async sendMessage (text, opt = {}) {
    const maxRetries = 5;
    const requestTimeout = 300000; // 从配置读取超时，默认300秒
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        return await this.attemptSendMessage(text, opt, requestTimeout);
      } catch (error) {
        lastError = error;
        // 只对网络超时、5xx系列错误、JSON解析失败、无效API响应、内容为空或被安全策略拦截、以及MALFORMED_FUNCTION_CALL进行重试
        const isRetryableError = 
          error.name === 'AbortError' || 
          (error.message && error.message.startsWith('API请求失败: 5')) ||
          (error.message && error.message.startsWith('JSON解析失败')) ||
          (error.message && error.message.startsWith('API返回无效响应')) ||
          (error.message && error.message.startsWith('API返回的content为空')) ||
          (error.message && error.message.startsWith('API返回内容被安全策略拦截')) ||
          (error.message && error.message.startsWith('MALFORMED_FUNCTION_CALL'));

        // if (isRetryableError) {
        if (true) {
          this._rotateKey();
          logger.warn(`[Gemini Client] 第 ${attempt} 次请求失败 (可重试错误): ${error.message}`);
          if (attempt < maxRetries) {
            const delay = Math.pow(2, attempt - 1) * 100; // 指数退避
            logger.info(`[Gemini Client] 将在 ${delay / 1000} 秒后重试...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } else {
          // 对于其他错误（如4xx客户端错误或函数执行错误），不重试，直接抛出
          logger.error(`[Gemini Client] 第 ${attempt} 次请求失败 (不可重试错误): ${error.message}`);
          throw lastError;
        }
      }
    }

    logger.error(`[Gemini Client] 所有 ${maxRetries} 次重试均失败。`);
    throw lastError;
  }

  _rotateKey() {
    if (this._keys && this._keys.length > 1) {
      this._keyIndex = (this._keyIndex + 1) % this._keys.length;
      this._key = this._keys[this._keyIndex];
      logger.info(`[Gemini Client] Rotated to new API key index: ${this._keyIndex}`);
    }
  }

  async attemptSendMessage(text, opt = {}, timeout) {
    let history = await this.getHistory(opt.parentMessageId)
    let systemMessage = opt.system

    // 检测API类型
    const isThirdPartyProxy = this._key.startsWith('sk-');
    
    // 增强的诊断日志
    try {
      const diagnosticInfo = {
        model: this.model,
        hasImage: !!opt.image,
        hasAudio: !!(opt.audio && opt.audio.data),
        historyLength: history.length,
        promptLength: text?.length || 0,
        apiType: isThirdPartyProxy ? 'third-party' : 'official'
      };
      if (opt.image) {
        diagnosticInfo.imageSize = opt.image.length;
      }
      if (opt.audio && opt.audio.data) {
        diagnosticInfo.audioSize = opt.audio.data.length;
      }
      console.log(`[Gemini Client] 发送请求，API类型: ${isThirdPartyProxy ? '第三方反代' : '官方Google API'}`);
    } catch (logError) {
      console.warn(`[Gemini Client] 记录诊断日志时出错: ${logError.message}`);
    }

    const idThis = crypto.randomUUID()
    const idModel = crypto.randomUUID()
    
    if (opt.functionResponse && !Array.isArray(opt.functionResponse)) {
      opt.functionResponse = [opt.functionResponse]
    }

    // 根据API类型构建不同的消息格式
    let body, url;
    
    if (isThirdPartyProxy) {
      // 第三方反代通常使用OpenAI兼容格式
      url = `${this.baseUrl}/v1/chat/completions`;
      
      // 转换历史消息格式
      const messages = [];
      
      // 添加系统消息
      if (systemMessage) {
        messages.push({
          role: 'system',
          content: systemMessage
        });
      }
      
      // 转换历史消息
      for (const msg of history) {
        if (msg.role === 'user') {
          let content = '';
          if (msg.parts) {
            for (const part of msg.parts) {
              if (part.text) content += part.text;
            }
          }
          if (content) {
            messages.push({
              role: 'user',
              content: content
            });
          }
        } else if (msg.role === 'model') {
          let content = '';
          if (msg.parts) {
            for (const part of msg.parts) {
              if (part.text) content += part.text;
            }
          }
          if (content) {
            messages.push({
              role: 'assistant',
              content: content
            });
          }
        }
      }
      
      // 添加当前消息
      if (text || opt.functionResponse?.length > 0) {
        const currentContent = text || '';
        messages.push({
          role: 'user',
          content: currentContent
        });
      }
      
      body = {
        model: this.model || 'gemini-1.5-pro',
        messages: messages,
        max_tokens: opt.maxOutputTokens || 4096,
        temperature: opt.temperature || 0.9,
        top_p: opt.topP || 0.95,
        stream: false
      };
      
    } else {
      // 官方Google API格式（保持原有逻辑）
      url = `${this.baseUrl}/v1beta/models/${this.model}:generateContent`;
      
      const thisMessage = opt.functionResponse?.length > 0
        ? {
            role: 'user',
            parts: opt.functionResponse.map(i => {
              return {
                functionResponse: i
              }
            }),
            id: idThis,
            parentMessageId: opt.parentMessageId || undefined
          }
        : {
            role: 'user',
            parts: text ? [{ text }] : [{ text: '' }],
            id: idThis,
            parentMessageId: opt.parentMessageId || undefined
          }
          
      if (opt.image) {
        thisMessage.parts.push({
          inline_data: {
            mime_type: 'image/jpeg',
            data: opt.image
          }
        })
      }
      if (opt.audio && opt.audio.data) {
        thisMessage.parts.push({
          inline_data: {
            mime_type: opt.audio.mimeType || 'audio/amr',
            data: opt.audio.data
          }
        });
      }
      
      // 确保parts不为空
      if (thisMessage.parts.length === 0) {
        thisMessage.parts.push({ text: '' });
      }
      
      history.push(_.cloneDeep(thisMessage))
      
      body = {
        contents: history,
        safetySettings: [
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.OFF
          },
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.OFF
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.OFF
          },
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.OFF
          },
          {
            category: HarmCategory.HARM_CATEGORY_CIVIC_INTEGRITY,
            threshold: HarmBlockThreshold.BLOCK_NONE
          }
        ],
        generationConfig: {
          maxOutputTokens: opt.maxOutputTokens || 4096,
          temperature: opt.temperature || 0.9,
          topP: opt.topP || 0.95,
          topK: opt.tokK || 16
        },
        tools: []
      }
      
      if (systemMessage) {
        body.system_instruction = {
          parts: [{
            text: systemMessage
          }]
        }
      }
      
      if (this.tools?.length > 0) {
        body.tools.push({
          function_declarations: this.tools.map(tool => tool.function())
        })
        let mode = opt.toolMode || 'AUTO'
        let lastFuncName = (opt.functionResponse)?.map(rsp => rsp.name)
        const mustSendNextTurn = [
          'searchImage', 'searchMusic', 'searchVideo'
        ]
        if (lastFuncName && lastFuncName?.find(name => mustSendNextTurn.includes(name))) {
          mode = 'ANY'
        }
        delete opt.toolMode
        body.tool_config = {
          function_calling_config: {
            mode
          }
        }
      }
      if (opt.search) {
        body.tools.push({ google_search: {} })
      }
      if (opt.codeExecution) {
        body.tools.push({ code_execution: {} })
      }
      if (opt.image) {
        delete body.tools
      }
      
      // 过滤和合并contents
      body.contents = body.contents.filter(content => content.parts && content.parts.length > 0);
      
      if (body.contents.length === 0) {
        throw new Error('请求中止：没有有效内容可发送 (contents 数组为空)');
      }
      
      body.contents.forEach(content => {
        delete content.id
        delete content.parentMessageId
        delete content.conversationId
      })
    }
    
    if (this.debug) {
      console.debug(`[Gemini Client] Request body:`, JSON.stringify(body, null, 2))
    }
    
    console.log(`[Gemini Client] Using API key: ${this._key.substring(0, 10)}...`);
    console.log(`[Gemini Client] Request URL: ${url}`);
    
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    // 根据API类型设置不同的请求头
    const headers = isThirdPartyProxy 
      ? {
          'Authorization': `Bearer ${this._key}`,
          'Content-Type': 'application/json'
        }
      : {
          'x-goog-api-key': this._key,
          'Content-Type': 'application/json'
        };

    let result
    try {
      result = await newFetch(url, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: headers,
        signal: controller.signal
      })
    } catch (error) {
      if (error.name === 'AbortError') {
        // 清理定时器后抛出特定错误
        clearTimeout(timeoutId);
        throw new Error('API请求超时');
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
    
    if (result.status !== 200) {
      let errorText = await result.text();
      let errorMessageToLog = errorText;

      // 如果是 5xx 错误且响应体为空，提供一个默认的描述性信息
      if (result.status >= 500 && result.status < 600 && !errorText.trim()) {
        errorMessageToLog = '服务器内部错误或网关超时';
      }

      console.error(`[Gemini] API请求失败，状态码: ${result.status}, 错误信息: ${errorMessageToLog}`);
      throw new Error(`API请求失败: ${result.status} - ${errorMessageToLog}`);
    }
    
    let response
    try {
      response = await result.json()
    } catch (parseError) {
      console.error(`[Gemini] JSON解析失败: ${parseError.message}`)
      throw new Error(`JSON解析失败: ${parseError.message}`)
    }
    
    if (this.debug) {
      console.log(`[Gemini Client] Response:`, JSON.stringify(response, null, 2))
    }
    
    // 根据API类型处理不同的响应格式
    let responseContent;
    let groundingMetadata;
    
    if (isThirdPartyProxy) {
      // 处理第三方反代的OpenAI格式响应
      if (!response || !response.choices || !Array.isArray(response.choices) || response.choices.length === 0) {
        throw new Error(`API返回无效响应: ${JSON.stringify(response)}`)
      }
      
      const choice = response.choices[0];
      if (!choice.message) {
        throw new Error(`API返回的消息为空: ${JSON.stringify(choice)}`)
      }
      
      // 转换为Gemini格式以保持兼容性
      responseContent = {
        role: 'model',
        parts: [{ text: choice.message.content || '' }]
      };
      
    } else {
      // 处理官方Google API格式响应
      if (!response || !response.candidates || !Array.isArray(response.candidates) || response.candidates.length === 0) {
        throw new Error(`API返回无效响应: ${JSON.stringify(response)}`)
      }
      
      responseContent = response.candidates[0].content
      groundingMetadata = response.candidates[0].groundingMetadata
      
      if (!responseContent) {
        if (response.candidates[0].finishReason === 'SAFETY') {
           throw new Error(`API返回内容被安全策略拦截: ${JSON.stringify(response.candidates[0])}`);
        }
        throw new Error(`API返回的content为空: ${JSON.stringify(response.candidates[0])}`)
      }
      
      if (response.candidates[0].finishReason === 'MALFORMED_FUNCTION_CALL') {
        console.warn('遇到MALFORMED_FUNCTION_CALL，将由重试机制处理。')
        throw new Error('MALFORMED_FUNCTION_CALL');
      }
    }

    // 函数调用处理（仅对官方API有效，第三方反代通常不支持）
    if (!isThirdPartyProxy && responseContent.parts && responseContent.parts.filter(i => i.functionCall).length > 0) {
      const functionCall = responseContent.parts.filter(i => i.functionCall).map(i => i.functionCall)
      const text = responseContent.parts.find(i => i.text)?.text
      if (text && text.trim()) {
        console.info('send message: ' + text.trim())
        opt.replyPureTextCallback && await opt.replyPureTextCallback(text.trim())
      }
      let fcResults = []
      for (let fc of functionCall) {
        console.info(JSON.stringify(fc))
        const funcName = fc.name
        let chosenTool = this.tools.find(t => t.name === funcName)
        let functionResponse = {
          name: funcName,
          response: {
            name: funcName,
            content: null
          }
        }
        if (!chosenTool) {
          functionResponse.response.content = {
            error: `Function ${funcName} doesn't exist`
          }
        } else {
          try {
            let isAdmin = ['admin', 'owner'].includes(this.e.sender.role) || (this.e.group?.is_admin && this.e.isMaster)
            let isOwner = ['owner'].includes(this.e.sender.role) || (this.e.group?.is_owner && this.e.isMaster)
            let args = Object.assign(fc.args, {
              isAdmin,
              isOwner,
              sender: this.e.sender.user_id,
              mode: 'gemini'
            })
            functionResponse.response.content = await chosenTool.func(args, this.e)
            if (this.debug) {
              console.info(JSON.stringify(functionResponse.response.content))
            }
          } catch (err) {
            console.error(err)
            functionResponse.response.content = {
              error: `Function execute error: ${err.message}`
            }
          }
        }
        fcResults.push(functionResponse)
      }
      let responseOpt = _.cloneDeep(opt)
      responseOpt.parentMessageId = idModel
      responseOpt.functionResponse = fcResults
      
      // 存储消息
      if (!isThirdPartyProxy) {
        await this.upsertMessage({
          role: 'user',
          parts: text ? [{ text }] : [{ text: '' }],
          id: idThis,
          parentMessageId: opt.parentMessageId || undefined
        })
      }
      
      responseContent = handleSearchResponse(responseContent).responseContent
      const respMessage = Object.assign(responseContent, {
        id: idModel,
        parentMessageId: idThis
      })
      await this.upsertMessage(respMessage)
      // The recursive call is now handled by the main sendMessage retry loop
      return await this.sendMessage('', responseOpt)
    }
    
    // 存储消息到历史记录
    if (responseContent) {
      // 存储用户消息
      const userMessage = {
        role: 'user',
        parts: text ? [{ text }] : [{ text: '' }],
        id: idThis,
        parentMessageId: opt.parentMessageId || undefined
      };
      await this.upsertMessage(userMessage);
      
      // 存储助手回复
      const respMessage = Object.assign(responseContent, {
        id: idModel,
        parentMessageId: idThis
      })
      await this.upsertMessage(respMessage)
    }
    
    if (!responseContent) {
      return {
        text: '',
        conversationId: '',
        parentMessageId: idThis,
        id: idModel
      }
    }
    
    let { final } = handleSearchResponse(responseContent)
    
    // 处理搜索结果元数据（仅官方API）
    if (!isThirdPartyProxy) {
      try {
        if (groundingMetadata?.groundingChunks) {
          final += '\n参考资料\n'
          groundingMetadata.groundingChunks.forEach(chunk => {
            final += `[${chunk.web.title}]\n`
          })
          if (groundingMetadata.webSearchQueries && Array.isArray(groundingMetadata.webSearchQueries)) {
            groundingMetadata.webSearchQueries.forEach(q => {
              console.info('search query: ' + q)
            })
          }
        }
      } catch (err) {
        console.warn(err)
      }
    }

    return {
      text: final,
      conversationId: '',
      parentMessageId: idThis,
      id: idModel
    }
  }
}

/**
 * 处理成单独的text
 * @param {Content} responseContent
 * @returns {{final: string, responseContent}}
 */
function handleSearchResponse (responseContent) {
  let final = ''

  // 检查responseContent和parts是否存在
  if (!responseContent || !responseContent.parts || !Array.isArray(responseContent.parts)) {
    return {
      final: '',
      responseContent: responseContent || { parts: [] }
    }
  }

  // 遍历每个 part 并处理
  responseContent.parts = responseContent.parts.map((part) => {
    let newText = ''

    if (part.text) {
      newText += part.text
      final += part.text // 累积到 final
    }
    if (part.executableCode) {
      const codeBlock = '\n执行代码：\n' + '```' + part.executableCode.language + '\n' + part.executableCode.code.trim() + '\n```\n\n'
      newText += codeBlock
      final += codeBlock // 累积到 final
    }
    if (part.codeExecutionResult) {
      const resultBlock = `\n执行结果(${part.codeExecutionResult.outcome})：\n` + '```\n' + part.codeExecutionResult.output + '\n```\n\n'
      newText += resultBlock
      final += resultBlock // 累积到 final
    }

    // 返回更新后的 part，但不设置空的 text
    const updatedPart = { ...part }
    if (newText) {
      updatedPart.text = newText // 仅在 newText 非空时设置 text
    } else {
      delete updatedPart.text // 如果 newText 是空的，则删除 text 字段
    }

    return updatedPart
  })

  return {
    final,
    responseContent
  }
}
