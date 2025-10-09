/**
 * @file greet.js
 * @description 这是一个用于定时向指定QQ用户发送问候消息的插件。
 *              它通过调用chat.js中的chatgpt接口实现消息发送。
 */

import plugin from '../../../lib/plugins/plugin.js'
import { chatgpt } from './chat.js' // 导入 chatgpt 类，用于调用其抽象聊天接口
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import _ from 'lodash'

// 用于 ES 模块中的 __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export class Greet extends plugin {
  /**
   * 辅助函数：将Date对象格式化为UTC+8时间字符串 (YYYY-MM-DDTHH:mm:ss.sss+08:00)
   * @param {Date} dateObject 要格式化的Date对象
   * @returns {string} 格式化后的时间字符串
   */
  formatToUTCPlus8(dateObject) {
    const year = dateObject.getFullYear();
    const month = (dateObject.getMonth() + 1).toString().padStart(2, '0');
    const day = dateObject.getDate().toString().padStart(2, '0');
    const hours = dateObject.getHours().toString().padStart(2, '0');
    const minutes = dateObject.getMinutes().toString().padStart(2, '0');
    const seconds = dateObject.getSeconds().toString().padStart(2, '0');
    const milliseconds = dateObject.getMilliseconds().toString().padStart(3, '0');

    // 直接使用本地时间组件并附加+08:00，避免复杂的UTC转换逻辑
    return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}+08:00`;
  }

  /**
   * @constructor
   * 插件的构造函数，用于初始化插件的名称、描述、事件和规则。
   */
  constructor () {
    super({
      name: '定时问候', // 插件名称
      dsc: '定时向指定用户发送问候消息', // 插件描述
      event: 'message', // 监听消息事件
      /** 定时任务，留空表示无定时任务 */
      task: [],
      rule: [
        {
          reg: '^#开启定时问候$', // 匹配开启命令的正则表达式
          fnc: 'startGreeting', // 对应执行的方法
          // permission: 'master' // 只有master权限的用户才能使用
        },
        {
          reg: '^#关闭定时问候$', // 匹配关闭命令的正则表达式
          fnc: 'stopGreeting', // 对应执行的方法
          // permission: 'master' // 只有master权限的用户才能使用
        },
        {
          reg: '.*', // 监听所有消息用于记录用户活动
          fnc: 'monitorUserActivity',
          log: false // 不记录日志避免刷屏
        }
      ]
    })
    // 真正实现单例模式
    if (Greet.instance) {
      // logger.info('[定时问候] 检测到重复实例化，将返回现有实例。');
      // 清理当前（重复）实例可能已经创建的定时器
      if (this.scanInterval) clearInterval(this.scanInterval);
      if (this.hourlyInterval) clearInterval(this.hourlyInterval);
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
      return Greet.instance;
    }

    // 防止重复实例化
    if (Greet.instance) {
      // logger.info('[定时问候] 检测到重复实例化，清理旧实例的定时器。');
      const oldInstance = Greet.instance;
      if (oldInstance.scanInterval) {
        clearInterval(oldInstance.scanInterval);
        oldInstance.scanInterval = null;
      }
      if (oldInstance.hourlyInterval) {
        clearInterval(oldInstance.hourlyInterval);
        oldInstance.hourlyInterval = null;
      }
      if (oldInstance.heartbeatInterval) {
        clearInterval(oldInstance.heartbeatInterval);
        oldInstance.heartbeatInterval = null;
      }
    }
    

    
    this.scanInterval = null // 用于存储 45秒扫描定时器的句柄
    this.hourlyInterval = null // 用于存储每小时更新定时器的句柄
    this.bot = null // 用于存储机器人实例，以便发送消息
    this.lastGreetingTime = null // 记录上次问候的时间，防止重复发送
    
    this.configFile = path.join(__dirname, 'greet_config.json') // 用户配置路径，保存在代码同目录
    this.userConfigs = {} // 用户配置缓存
    this.loadConfig() // 加载用户配置文件

    this.logFile = path.join(__dirname, 'greet_log.json') // 日志文件路径

    // 绑定方法，确保 'this' 上下文正确
    this.startGreeting = this.startGreeting.bind(this);
    this.stopGreeting = this.stopGreeting.bind(this);
    this.sendActualGreeting = this.sendActualGreeting.bind(this);
    this.loadConfig = this.loadConfig.bind(this);
    this.saveConfig = this.saveConfig.bind(this);
    this.isUserEnabled = this.isUserEnabled.bind(this);
    this.setUserStatus = this.setUserStatus.bind(this);
    this.addLogEntry = this.addLogEntry.bind(this);
    this.scanAndExecuteGreeting = this.scanAndExecuteGreeting.bind(this);
    this.formatToUTCPlus8 = this.formatToUTCPlus8.bind(this);

    // 机器人启动时自动启动定时器系统
    this.initializeTimerSystem();
    
    // 设置单例实例引用
    Greet.instance = this;
    this.chatgpt = new chatgpt();
  }

  /**
   * 初始化定时器系统
   */
  async initializeTimerSystem() {
    // 每50秒扫描并执行到期的问候任务
    this.task.push({
      name: 'scanAndExecuteGreeting',
      fnc: this.scanAndExecuteGreeting.bind(this),
      cron: '*/50 * * * * *'
    });

    // 每小时检查并更新所有用户的问候计划
    this.task.push({
      name: 'reviewGreetingPlans',
      fnc: this.reviewGreetingPlans.bind(this),
      cron: '0 0 * * * *' // 每小时的0分0秒执行
    });
  }

  /**
   * 加载用户配置文件
   */
  loadConfig() {
    try {
      // 如果配置文件存在，则读取
      if (fs.existsSync(this.configFile)) {
        const data = fs.readFileSync(this.configFile, 'utf8')
        
        // 检查文件内容是否有效
        if (!data || data.trim() === '') {
          logger.warn('[定时问候] 用户配置文件为空，将重新创建默认配置。')
          this.userConfigs = {}
          this.saveConfig()
          return
        }
        
        // 尝试解析JSON
        try {
          this.userConfigs = JSON.parse(data)
          logger.info('[定时问候] 用户配置文件加载成功：', this.userConfigs)
        } catch (parseError) {
          logger.error('[定时问候] 用户配置JSON解析失败，文件内容：', data)
          logger.error('[定时问候] 用户配置JSON解析错误详情：', parseError.message)
          
          // 备份损坏的文件
          const backupFile = this.configFile + '.backup.' + Date.now()
          fs.writeFileSync(backupFile, data, 'utf8')
          logger.info(`[定时问候] 已备份损坏的用户配置文件至：${backupFile}`)
          
          // 重新创建默认配置
          this.userConfigs = {}
          this.saveConfig()
          logger.info('[定时问候] 已重新创建默认用户配置。')
        }
      } else {
        // 如果配置文件不存在，创建默认配置
        this.userConfigs = {}
        this.saveConfig()
        logger.info('[定时问候] 用户配置文件不存在，已创建新的默认配置。')
      }
    } catch (error) {
      logger.error('[定时问候] 加载用户配置文件时出错：', error)
      logger.error('[定时问候] 错误堆栈：', error.stack)
      this.userConfigs = {}
      
      // 尝试创建默认配置
      try {
        this.saveConfig()
      } catch (saveError) {
        logger.error('[定时问候] 保存默认用户配置也失败：', saveError)
      }
    }
  }

  /**
   * 保存用户配置文件
   */
  saveConfig() {
    try {
      // 确保用户配置对象的格式正确
      const cleanConfigs = {}
      for (const [userId, config] of Object.entries(this.userConfigs)) {
        if (userId && typeof userId === 'string' && typeof config === 'object') {
          cleanConfigs[userId] = {
            status: config.status === 'on' ? 'on' : 'off',
            nextGreetingTimestamp: config.nextGreetingTimestamp || null
          };
        }
      }
      
      const jsonString = JSON.stringify(cleanConfigs, null, 2)
      fs.writeFileSync(this.configFile, jsonString, 'utf8')
      logger.info('[定时问候] 用户配置文件保存成功。')
      
      // 更新内存中的配置
      this.userConfigs = cleanConfigs
    } catch (error) {
      logger.error('[定时问候] 保存用户配置文件时出错：', error)
      logger.error('[定时问候] 尝试保存的配置：', this.userConfigs)
    }
  }

  /**
   * 每50秒扫描并执行问候任务
   */
  async scanAndExecuteGreeting() {
    const now = new Date();
    const enabledUsers = Object.keys(this.userConfigs).filter(userId => this.userConfigs[userId]?.status === 'on');

    for (const userId of enabledUsers) {
      const userConfig = this.userConfigs[userId];
      if (userConfig.nextGreetingTimestamp && now.getTime() > userConfig.nextGreetingTimestamp) {
        logger.info(`[定时问候] 用户 ${userId} 的问候时间已到，准备发送问候...`);
        
        // 生成并发送问候消息
        const currentTime = this.formatToUTCPlus8(new Date());
        const message = await this.generateContextualGreeting(userId, currentTime);
        if (message) {
          await this.sendActualGreeting(userId, message, true);
        }
        
        // 任务执行后清除时间戳，等待AI下一次指令
        userConfig.nextGreetingTimestamp = null;
        this.saveConfig();
        logger.info(`[定时问候] 用户 ${userId} 的问候任务已执行并清除。`);
      }
    }
  }

  /**
   * 每小时调用AI，为每个开启的用户征求问候计划的调整意见
   */
  async reviewGreetingPlans() {
    logger.info('[定时问候] === 开始每小时检查所有用户的问候计划 ===');
    const enabledUsers = Object.keys(this.userConfigs).filter(userId => this.userConfigs[userId]?.status === 'on');

    for (const userId of enabledUsers) {
      try {
        const userConfig = this.userConfigs[userId];
        const plan = userConfig.nextGreetingTimestamp 
          ? `计划在 ${new Date(userConfig.nextGreetingTimestamp).toLocaleString('zh-CN')} 左右`
          : '当前没有主动问候计划';

        const context = await this.getUserConversationContext(userId);
        const history = context.recentMessages.map(item => `${item.role}: ${item.content}`).join('\n');
        
        const prompt = `【背景】我是你的AI助手，正在管理对用户 ${userId} 的主动问候计划。\n【当前计划】${plan}。\n【历史摘要】\n${history}\n【任务】请根据我们的历史互动，判断是否需要调整主动问候计划。如果需要，请在回复的最后用 {{消息意愿:分钟数}} 格式给出新的计划（-1代表取消所有计划）。如果认为当前计划无需变动，则不要包含任何“消息意愿”标记。`;

        logger.info(`[定时问候] 正在为用户 ${userId} 询问AI调整计划...`);
        
        // 创建一个临时的 e 对象来调用 getResponse
        const dummyE = { user_id: userId, isPrivate: true };
        const aiResponse = await this.chatgpt.getResponse(prompt, dummyE);

        if (aiResponse && aiResponse.text) {
          const willingnessRegex = /\{\{消息意愿:(-?\d+)\}\}/;
          const match = aiResponse.text.match(willingnessRegex);

          if (match) {
            const minutes = parseInt(match[1], 10);
            logger.info(`[定时问候] AI为用户 ${userId} 提出了新的计划: ${minutes}分钟`);
            this.updateGreetingPlan(userId, minutes);
          } else {
            logger.info(`[定时问候] AI认为用户 ${userId} 的计划无需调整。`);
          }
        }
      } catch (error) {
        logger.error(`[定时问候] 为用户 ${userId} 检查计划时出错:`, error);
      }
    }
    logger.info('[定时问候] === 每小时计划检查结束 ===');
  }

  /**
   * 更新指定用户的问候计划
   * @param {string} userId 用户ID
   * @param {number} minutes 分钟数，-1表示取消
   */
  updateGreetingPlan(userId, minutes) {
    if (!this.userConfigs[userId]) {
      this.userConfigs[userId] = { status: 'off', nextGreetingTimestamp: null };
    }
    
    // 兼容旧的配置格式：如果配置是字符串，转换为对象格式
    if (typeof this.userConfigs[userId] === 'string') {
      const oldStatus = this.userConfigs[userId];
      this.userConfigs[userId] = { 
        status: oldStatus, 
        nextGreetingTimestamp: null 
      };
      logger.info(`[定时问候] 自动升级用户 ${userId} 的配置格式`);
    }
    
    const userConfig = this.userConfigs[userId];

    if (minutes === -1) {
      userConfig.nextGreetingTimestamp = null;
      logger.info(`[定时问候] 已为用户 ${userId} 取消所有主动问候计划。`);
    } else if (minutes > 0) {
      const nextTime = new Date().getTime() + minutes * 60 * 1000;
      userConfig.nextGreetingTimestamp = nextTime;
      logger.info(`[定时问候] 已为用户 ${userId} 设置新的问候时间: ${new Date(nextTime).toLocaleString('zh-CN')}`);
    }
    // 如果 minutes 为 0 或其他无效值，则不作处理

    this.saveConfig();
  }

  /**
   * 添加日志条目
   * @param {object} data 要记录的数据
   */
  addLogEntry(data) {
    // 记录 type 为 'probabilityCheck'、'greeting' 或 'waitingMessage' 的日志
    if (data.type === 'probabilityCheck' || data.type === 'greeting' || data.type === 'waitingMessage') {
      try {
        const logEntry = {
          timestamp: this.formatToUTCPlus8(new Date()), // 保存为UTC+8时间
          ...data
        }
        fs.appendFileSync(this.logFile, JSON.stringify(logEntry) + '\n', 'utf8')
        
        // 为取消事件添加特殊日志输出
        if (data.action === 'waitingInquiryCancelled') {
          logger.info(`[定时问候] 已取消用户 ${data.userId} 的询问问候 - 用户在等待期间回复了消息`)
        }
      } catch (error) {
        logger.error('[定时问候] 添加日志条目时出错：', error)
      }
    }
  }

  /**
   * 检查指定用户是否已开启定时问候
   * @param {string} userId 用户ID
   * @returns {boolean} 是否开启
   */
  isUserEnabled(userId) {
    // 兼容旧格式：如果是字符串，检查是否为 'on'
    if (typeof this.userConfigs[userId] === 'string') {
      return this.userConfigs[userId] === 'on';
    }
    // 新格式：检查 status 字段
    const isEnabled = this.userConfigs[userId]?.status === 'on'
    return isEnabled
  }

  /**
   * 获取用户的对话历史上下文
   * @param {string} targetQQ 目标QQ号
   * @returns {Promise<object>} 返回对话上下文信息
   */
  async getUserConversationContext(targetQQ) {
    try {
      const key = `CHATGPT:CONVERSATIONS_GEMINI:${targetQQ}`
      const conversationData = await redis.get(key)
      
      if (conversationData) {
        const conversation = JSON.parse(conversationData)
        const recentMessages = conversation.messages?.slice(-5) || []
        
        return {
          hasHistory: true,
          recentMessages: recentMessages,
        }
      } else {
        logger.info(`[定时问候] 用户 ${targetQQ} 无对话历史`)
        return { hasHistory: false, recentMessages: [] }
      }
    } catch (error) {
      logger.error(`[定时问候] 获取用户 ${targetQQ} 对话上下文失败:`, error)
      return { hasHistory: false, recentMessages: [], error: error.message }
    }
  }

  /**
   * 根据用户上下文生成个性化问候消息
   * @param {string} targetQQ 目标QQ号
   * @param {string} currentTime 当前时间
   * @returns {Promise<string>} 返回个性化的问候消息
   */
  async generateContextualGreeting(targetQQ, currentTime) {
    try {
      const context = await this.getUserConversationContext(targetQQ);
      const history = context.recentMessages.map(item => `${item.role}: ${item.content}`).join('\n');
      
      const prompt = `现在是 ${currentTime}。基于我们过去的对话记录:\n${history}\n\n请你以自然的、朋友般的口吻，主动发起一段新的对话。`;

      // 直接调用 chatgpt 实例的方法来获取AI回复
      const dummyE = { user_id: targetQQ, isPrivate: true };
      const res = await this.chatgpt.getResponse(prompt, dummyE);
      
      if (res && res.text) {
        // 移除AI回复中可能误带的意愿标记，因为这里的意愿应在对话中产生
        return res.text.replace(/\{\{消息意愿:(-?\d+)\}\}/, '').trim();
      }
      return '你好呀，最近怎么样？'; // Fallback
    } catch (error) {
      logger.error('生成个性化问候消息失败:', error);
      return '你好呀！'; // Fallback
    }
  }

  /**
   * 设置用户定时问候状态
   * @param {string} userId 用户ID
   * @param {string} status 状态 ('on' 或 'off')
   */
  setUserStatus(userId, status) {
    logger.info(`[定时问候] 设置用户 ${userId} 状态为：${status}`)
    if (!this.userConfigs[userId]) {
      this.userConfigs[userId] = { status: 'off', nextGreetingTimestamp: null };
    }
    
    // 兼容旧的配置格式：如果配置是字符串，转换为对象格式
    if (typeof this.userConfigs[userId] === 'string') {
      const oldStatus = this.userConfigs[userId];
      this.userConfigs[userId] = { 
        status: oldStatus, 
        nextGreetingTimestamp: null 
      };
      logger.info(`[定时问候] 自动升级用户 ${userId} 的配置格式`);
    }
    
    this.userConfigs[userId].status = status;
    this.saveConfig()
  }

  /**
   * 监听用户活动，记录消息时间
   * @param {object} e 消息事件对象
   */
  async monitorUserActivity(e) {
    // 该函数在新的AI驱动模式下不再需要，但保留以备将来使用
    return false // 返回false，不阻止其他插件处理该消息
  }

  /**
   * 处理 #开启定时问候 命令
   * @param {object} e 消息事件对象
   */
  async startGreeting (e) {
    const userId = e.sender.user_id.toString()
    this.bot = e.bot // 更新机器人实例
    const wasEnabled = this.isUserEnabled(userId);

    // 设置用户状态为开启
    this.setUserStatus(userId, 'on')
    logger.info(`[定时问候] 用户 ${userId} 发送 #开启定时问候 命令。`)

    if (wasEnabled) {
      e.reply(`您已经开启了定时问候功能。`, true)
    } else {
      e.reply(`定时问候已开启，现在将由AI根据对话情况决定何时主动找你聊天。`, true)
    }
    logger.info(`[定时问候] 用户 ${userId} 已成功处理开启命令。`)
  }

  /**
   * 处理 #关闭定时问候 命令
   * @param {object} e 消息事件对象
   */
  async stopGreeting (e) {
    logger.info('[定时问候] 收到关闭定时问候命令。')
    const userId = e.sender.user_id.toString()
    logger.info(`[定时问候] 用户 ${userId} 发送 #关闭定时问候 命令。`)

    if (!this.isUserEnabled(userId)) {
      e.reply('您还没有开启定时问候功能', true)
      logger.info(`[定时问候] 用户 ${userId} 未开启，跳过关闭操作。`)
      return
    }

    this.setUserStatus(userId, 'off')
    // 同时取消任何待处理的问候
    this.updateGreetingPlan(userId, -1);

    logger.info(`[定时问候] 用户 ${userId} 的定时问候已成功关闭。`)
    e.reply('定时问候已关闭', true) 
  }

  /**
   * 实际发送消息的辅助函数
   * @param {string} targetQQ 目标QQ号
   * @param {string} message 消息内容
   * @param {boolean} recordTime 是否记录本次发送的时间
   */
  async sendActualGreeting(targetQQ, message, recordTime = true) {
    logger.info(`[定时问候] 准备为QQ: ${targetQQ} 发送实际问候消息。`)

    if (!this.bot) {
      if (typeof Bot !== 'undefined' && Bot.uin) {
        this.bot = Bot;
      } else {
        logger.error("[定时问候] 机器人实例未设置，无法发送问候消息。")
        return
      }
    }
    
    // 获取用户信息（如果可能的话）
    let userInfo = { user_id: targetQQ, nickname: '定时问候用户' }
    try {
      const friendInfo = await this.bot.pickFriend(targetQQ).getInfo()
      if (friendInfo) {
        userInfo = {
          user_id: targetQQ,
          nickname: friendInfo.nickname || friendInfo.nick || '定时问候用户'
        }
      }
    } catch (error) {
      logger.info(`[定时问候] 无法获取用户 ${targetQQ} 的详细信息，使用默认信息`)
    }
    
    // 模拟一个增强的事件对象 e，以符合 chat.js 中 abstractChat 方法的参数要求
    const dummyEvent = {
      isPrivate: true, // 标记为私聊消息
      isGroup: false, // 不是群聊
      user_id: targetQQ, // 消息发送者ID（这里是目标QQ）
      sender: userInfo, // 发送者信息
      msg: message, // 消息内容
      message: [{ type: 'text', text: message }], // 消息数组格式
      raw_message: message, // 原始消息
      source: null, // 没有引用消息
      atme: false, // 没有@机器人
      atBot: false, // 没有@机器人
      reply: async (msg, quote, data) => {
        try {
          await this.bot.pickFriend(targetQQ).sendMsg(msg)
        } catch (error) {
          logger.error(`[定时问候] 发送消息至 ${targetQQ} 失败:`, error)
        }
      },
    }

    const chat = new chatgpt(dummyEvent) // 创建 chatgpt 实例
    chat.e = dummyEvent // 显式设置 chatgpt 实例的 e 属性，确保 chat.js 内部的 this.e 有效
    try {
      await chat.abstractChat(dummyEvent, message, 'gemini')
      logger.info(`[定时问候] abstractChat 调用完成为 ${targetQQ}。`)
      
    } catch (error) {
      logger.error(`[定时问候] 调用 abstractChat 为 ${targetQQ} 时出错:`, error)
    }
  }

}

export default Greet
