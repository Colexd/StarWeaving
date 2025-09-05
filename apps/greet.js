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
import { ConversationManager } from '../model/conversation.js' // 导入对话管理器

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
    
    // 全局问候消息模板
    this.greetingMessageTemplate = `【system】现在的时间是：{currentTime}，触发了主动聊天事件。（这条消息不用发表情和定时命令）
      接下来的情景是你要假扮在主动找用户聊天，你可以像真人一样根据现在的时间和在做什么情况来主动给用户发送消息
      （如：熬夜的时间可以说是在加班，半夜的时间可以说是失眠或者起夜上厕所之类的）。
      可以是询问之前的聊天内容，或者吐槽学习生活或工作，或者问候吃没吃饭自己吃的什么饭，或者早晚安，或者单纯的一句打招呼都可以。
      吃了什么饭，日常工作趣事，偶然事件或者午觉，都是很好的话题。
      （你不知道用户在做什么的情况下，这次是你主动地问候一下，而不是用户找你）。
      如果上次的消息没有被回复一定要问一下用户在做什么。
      尽量做到有感情色彩，按照多姿多彩的生活来问候。
      请避免询问类似：“这么晚了还没休息吗？”这种无端的问题因为你不知道是不是在休息，而是询问类似“休息了吗”之类的
      如果在和用户的正常聊天的过程中触发了主动聊天，可以讲一些题外话（比如说：对了，上次xxxxxx）。`
    
    this.configFile = path.join(__dirname, 'greet_config.json') // 用户配置路径，保存在代码同目录
    this.userConfigs = {} // 用户配置缓存
    this.loadConfig() // 加载用户配置文件

    this.logFile = path.join(__dirname, 'greet_log.json') // 日志文件路径
    this.runConfigFile = path.join(__dirname, 'greet_run.json') // 运行配置（调度计划）文件路径
    this.runConfig = {} // 运行配置缓存
    this.loadRunConfig() // 加载运行配置文件

    this.messageWaitFile = path.join(__dirname, 'message_wait.json') // 消息等待记录文件路径
    this.messageWaitRecords = {} // 消息等待记录缓存
    this.loadMessageWaitRecords() // 加载消息等待记录

    // 添加心跳日志，每45秒输出一次证明程序正在运行
    this.heartbeatInterval = setInterval(() => {
      const enabledUsersCount = Object.values(this.userConfigs).filter(status => status === 'on').length;
      const waitingRecordsCount = Object.keys(this.messageWaitRecords).length;
      logger.info(`[定时问候-心跳] ${new Date().toLocaleString('zh-CN')} | 运行状态: 正常 | 开启用户数: ${enabledUsersCount} | 等待记录数: ${waitingRecordsCount} | 扫描定时器: ${this.scanInterval ? '运行中' : '未启动'} | 每小时定时器: ${this.hourlyInterval ? '运行中' : '未启动'}`);
    }, 45000) // 每45秒执行一次

    // 绑定方法，确保 'this' 上下文正确
    this.startGreeting = this.startGreeting.bind(this);
    this.stopGreeting = this.stopGreeting.bind(this);
    this.sendActualGreeting = this.sendActualGreeting.bind(this);
    this.loadConfig = this.loadConfig.bind(this);
    this.saveConfig = this.saveConfig.bind(this);
    this.isUserEnabled = this.isUserEnabled.bind(this);
    this.setUserStatus = this.setUserStatus.bind(this);
    this.addLogEntry = this.addLogEntry.bind(this);
    this.loadRunConfig = this.loadRunConfig.bind(this);
    this.saveRunConfig = this.saveRunConfig.bind(this);
    this.scanAndExecuteGreeting = this.scanAndExecuteGreeting.bind(this); // 新的扫描执行方法
    this.generateNextHourGreetingTime = this.generateNextHourGreetingTime.bind(this); // 新的生成下个小时时间方法
    this.updateHourlyGreetingTime = this.updateHourlyGreetingTime.bind(this); // 新的每小时更新方法
    this.formatToUTCPlus8 = this.formatToUTCPlus8.bind(this);
    this.loadMessageWaitRecords = this.loadMessageWaitRecords.bind(this);
    this.saveMessageWaitRecords = this.saveMessageWaitRecords.bind(this);
    this.startWaitTimerForUser = this.startWaitTimerForUser.bind(this);
    this.checkAndSendWaitingMessages = this.checkAndSendWaitingMessages.bind(this);
    this.monitorUserActivity = this.monitorUserActivity.bind(this);

    // 机器人启动时自动启动定时器系统
    this.initializeTimerSystem();
    
    // 设置单例实例引用
    Greet.instance = this;
  }

  /**
   * 初始化定时器系统
   */
  async initializeTimerSystem() {
    logger.info('[定时问候] 机器人启动 - 自动初始化定时器系统。');
    
    // 立即生成本小时的问候计划
    await this.updateHourlyGreetingTime();

    // 启动每50秒的扫描定时器
    this.scanInterval = setInterval(async () => {
      await this.scanAndExecuteGreeting();
      await this.checkAndSendWaitingMessages(); // 检查消息等待状态
    }, 50000); // 每50秒执行一次
    logger.info('[定时问候] 50秒扫描定时器已启动（包含消息等待检查）。');

    // 计算到下一个整点的时间
    const now = new Date();
    const nextFullHour = new Date(now);
    nextFullHour.setHours(now.getHours() + 1);
    nextFullHour.setMinutes(0);
    nextFullHour.setSeconds(0);
    nextFullHour.setMilliseconds(0);
    const initialDelay = nextFullHour.getTime() - now.getTime();

    logger.info(`[定时问候] 首次每小时更新将在 ${nextFullHour.toLocaleString('zh-CN')} 进行（${Math.round(initialDelay / 1000)} 秒后）。`);

    // 设置首次每小时更新
    setTimeout(() => {
      logger.info('[定时问候] 首次每小时更新触发。');
      this.updateHourlyGreetingTime();
      
      // 启动每小时的定时器
      this.hourlyInterval = setInterval(async () => {
        logger.info('[定时问候] 每小时更新定时器触发。');
        await this.updateHourlyGreetingTime();
      }, 3600000); // 每小时执行一次
      logger.info('[定时问候] 每小时更新定时器已启动。');
    }, initialDelay);
    
    logger.info('[定时问候] 定时器系统初始化完成。');
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
      for (const [userId, status] of Object.entries(this.userConfigs)) {
        if (userId && typeof userId === 'string' && (status === 'on' || status === 'off')) {
          cleanConfigs[userId] = status
        }
      }
      
      const jsonString = JSON.stringify(cleanConfigs, null, 2)
      fs.writeFileSync(this.configFile, jsonString, 'utf8')
      logger.info('[定时问候] 用户配置文件保存成功：', cleanConfigs)
      
      // 更新内存中的配置
      this.userConfigs = cleanConfigs
    } catch (error) {
      logger.error('[定时问候] 保存用户配置文件时出错：', error)
      logger.error('[定时问候] 尝试保存的配置：', this.userConfigs)
    }
  }

  /**
   * 加载运行配置文件 (greet_run.json)
   * @param {boolean} silent 是否静默加载（不输出详细日志）
   */
  loadRunConfig(silent = false) {
    try {
      if (fs.existsSync(this.runConfigFile)) {
        const data = fs.readFileSync(this.runConfigFile, 'utf8')
        
        // 检查文件内容是否有效
        if (!data || data.trim() === '') {
          logger.warn('[定时问候] 运行配置文件为空，将重新创建默认配置。')
          this.runConfig = {}
          this.saveRunConfig()
          return
        }
        
        // 尝试解析JSON，如果失败则提供详细的错误信息
        try {
          this.runConfig = JSON.parse(data)
        } catch (parseError) {
          logger.error('[定时问候] JSON解析失败，文件内容：', data)
          logger.error('[定时问候] JSON解析错误详情：', parseError.message)
          
          // 备份损坏的文件
          const backupFile = this.runConfigFile + '.backup.' + Date.now()
          fs.writeFileSync(backupFile, data, 'utf8')
          logger.info(`[定时问候] 已备份损坏的配置文件至：${backupFile}`)
          
          // 重新创建默认配置
          this.runConfig = {}
          this.saveRunConfig()
          logger.info('[定时问候] 已重新创建默认运行配置。')
          return
        }
        
        // 只在非静默模式下输出详细日志
        if (!silent) {
          const timestamp = this.runConfig.timestamp || '未设置';
          const shouldSend = this.runConfig.shouldSend ? '是' : '否';
          const nextGreetingTime = this.runConfig.nextGreetingTime || '未设置';
          logger.info(`=== 定时问候 ===\n运行时间：${timestamp} | 是否发送：${shouldSend} | 下次问候：${nextGreetingTime}`)
        }
      } else {
        this.runConfig = {}
        this.saveRunConfig()
        if (!silent) {
          logger.info('[定时问候] 运行配置文件不存在，已创建新的默认配置。')
        }
      }
    } catch (error) {
      logger.error('[定时问候] 加载运行配置文件时出错：', error)
      logger.error('[定时问候] 错误堆栈：', error.stack)
      this.runConfig = {}
      
      // 如果是文件系统错误，也尝试创建默认配置
      try {
        this.saveRunConfig()
      } catch (saveError) {
        logger.error('[定时问候] 保存默认配置也失败：', saveError)
      }
    }
  }

  /**
   * 保存运行配置文件 (greet_run.json)
   */
  saveRunConfig() {
    try {
      // 确保运行配置对象的所有值都是有效的
      const cleanConfig = {
        timestamp: this.runConfig.timestamp || this.formatToUTCPlus8(new Date()),
        randomMinute: typeof this.runConfig.randomMinute === 'number' ? this.runConfig.randomMinute : 0,
        shouldSend: Boolean(this.runConfig.shouldSend),
        hour: typeof this.runConfig.hour === 'number' ? this.runConfig.hour : new Date().getHours(),
        nextGreetingTime: this.runConfig.nextGreetingTime || null
      }
      
      const jsonString = JSON.stringify(cleanConfig, null, 2)
      fs.writeFileSync(this.runConfigFile, jsonString, 'utf8')
      logger.info('[定时问候] 运行配置保存成功：', cleanConfig)
    } catch (error) {
      logger.error('[定时问候] 保存运行配置文件时出错：', error)
      logger.error('[定时问候] 尝试保存的配置：', this.runConfig)
    }
  }

  /**
   * 加载消息等待记录文件 (message_wait.json)
   */
  loadMessageWaitRecords() {
    try {
      if (fs.existsSync(this.messageWaitFile)) {
        const data = fs.readFileSync(this.messageWaitFile, 'utf8')
        
        // 检查文件内容是否有效
        if (!data || data.trim() === '') {
          logger.warn('[定时问候] 消息等待记录文件为空，将重新创建默认配置。')
          this.messageWaitRecords = {}
          this.saveMessageWaitRecords()
          return
        }
        
        // 尝试解析JSON
        try {
          this.messageWaitRecords = JSON.parse(data)
          // logger.info('[定时问候] 消息等待记录文件加载成功，记录数量：', Object.keys(this.messageWaitRecords).length)
        } catch (parseError) {
          logger.error('[定时问候] 消息等待记录JSON解析失败，文件内容：', data)
          logger.error('[定时问候] 消息等待记录JSON解析错误详情：', parseError.message)
          
          // 备份损坏的文件
          const backupFile = this.messageWaitFile + '.backup.' + Date.now()
          fs.writeFileSync(backupFile, data, 'utf8')
          logger.info(`[定时问候] 已备份损坏的消息等待记录文件至：${backupFile}`)
          
          // 重新创建默认配置
          this.messageWaitRecords = {}
          this.saveMessageWaitRecords()
          logger.info('[定时问候] 已重新创建默认消息等待记录。')
        }
      } else {
        // 如果文件不存在，创建默认配置
        this.messageWaitRecords = {}
        this.saveMessageWaitRecords()
        logger.info('[定时问候] 消息等待记录文件不存在，已创建新的默认配置。')
      }
    } catch (error) {
      logger.error('[定时问候] 加载消息等待记录文件时出错：', error)
      logger.error('[定时问候] 错误堆栈：', error.stack)
      this.messageWaitRecords = {}
      
      // 尝试创建默认配置
      try {
        this.saveMessageWaitRecords()
      } catch (saveError) {
        logger.error('[定时问候] 保存默认消息等待记录也失败：', saveError)
      }
    }
  }

  /**
   * 保存消息等待记录文件 (message_wait.json)
   */
  saveMessageWaitRecords() {
    try {
      // 确保消息等待记录对象的格式正确
      const cleanRecords = {}
      for (const [userId, timestamp] of Object.entries(this.messageWaitRecords)) {
        if (userId && typeof userId === 'string' && timestamp) {
          cleanRecords[userId] = timestamp
        }
      }
      
      const jsonString = JSON.stringify(cleanRecords, null, 2)
      fs.writeFileSync(this.messageWaitFile, jsonString, 'utf8')
      logger.info('[定时问候] 消息等待记录文件保存成功，记录数量：', Object.keys(cleanRecords).length)
      
      // 更新内存中的记录
      this.messageWaitRecords = cleanRecords
    } catch (error) {
      logger.error('[定时问候] 保存消息等待记录文件时出错：', error)
      logger.error('[定时问候] 尝试保存的记录：', this.messageWaitRecords)
    }
  }

  /**
   * 记录机器人回复的时间，并启动等待计时器
   * @param {string} userId 用户ID
   */
  startWaitTimerForUser(userId) {
    const currentTime = this.formatToUTCPlus8(new Date())
    this.messageWaitRecords[userId] = currentTime
    this.saveMessageWaitRecords()
    // logger.info(`[定时问候] 记录机器人回复时间 ${userId}: ${currentTime}，开始等待用户回复。`)
  }

  /**
   * 检查并发送等待消息
   */
  async checkAndSendWaitingMessages() {
    const now = new Date()
    const enabledUsers = Object.keys(this.userConfigs).filter(userId => this.userConfigs[userId] === 'on')
    
    if (enabledUsers.length === 0) {
      return // 没有开启用户，直接返回
    }
    
    const waitingUsersCount = Object.keys(this.messageWaitRecords).length
    // logger.info(`[定时问候] 开始检查消息等待状态，共 ${enabledUsers.length} 个开启用户，等待中用户数: ${waitingUsersCount}`)
    
    let processedCount = 0
    let sentCount = 0
    let cancelledCount = 0
    
    for (const userId of enabledUsers) {
      if (this.messageWaitRecords[userId]) {
        processedCount++
        const lastMessageTime = new Date(this.messageWaitRecords[userId])
        const timeDifference = now.getTime() - lastMessageTime.getTime()
        const minutesDifference = Math.floor(timeDifference / (1000 * 60))
        
        // 生成5-30分钟的随机等待时间
        const randomWaitMinutes = Math.floor(Math.random() * 26) + 5 // 5到30分钟的随机等待时间
        
        logger.info(`[定时问候] 用户 ${userId} 机器人最后回复时间: ${this.messageWaitRecords[userId]}, 已过 ${minutesDifference} 分钟, 等待阈值: ${randomWaitMinutes} 分钟`)

        if (minutesDifference >= randomWaitMinutes) {
          logger.info(`[定时问候] 用户 ${userId} 已等待 ${minutesDifference} 分钟 (阈值: ${randomWaitMinutes} 分钟)，进行概率检测...`)
          
          // 增加80%的概率检测
          if (Math.random() < 0.8) {
            logger.info(`[定时问候] 用户 ${userId} 通过80%概率检测，准备发送询问消息`)
            
            // 生成询问消息
            const currentTimeStr = now.toLocaleString('zh-CN')
            const waitingPrompt = `【system】：现在时间是${currentTimeStr}，对话人已经${minutesDifference}分钟没有回复消息，在这样的情境下请根据上下文内容，模拟问候他在做什么，或者继续说你要说的话。`
            
            // 发送询问消息，且不记录本次发送的时间
            await this.sendActualGreeting(userId, waitingPrompt, false)
            sentCount++
            logger.info(`[定时问候] 已向用户 ${userId} 发送等待询问消息`)
            
            // 记录日志
            this.addLogEntry({
              type: 'waitingMessage',
              action: 'waitingInquirySent',
              userId: userId,
              waitMinutes: minutesDifference,
              randomThreshold: randomWaitMinutes,
              messageContent: waitingPrompt.substring(0, 200) + '...',
              sentAt: this.formatToUTCPlus8(now)
            })
            
            // 清除该用户的等待记录，避免重复发送
            delete this.messageWaitRecords[userId]
            this.saveMessageWaitRecords()
          } else {
            logger.info(`[定时问候] 用户 ${userId} 未通过80%的概率检测，本次跳过，等待下次检查。`)
          }
        }
      }
    }
    
    if (processedCount > 0) {
      logger.info(`[定时问候] 等待检查完成: 处理 ${processedCount} 个等待用户, 发送询问 ${sentCount} 个, 取消 ${cancelledCount} 个`)
    }
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
   * 生成下个小时的随机问候时间
   * @returns {Date} 下个小时的随机时间
   */
  generateNextHourGreetingTime() {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(now.getHours() + 1);
    
    // 生成随机分钟数（1-59）
    const randomMinute = Math.floor(Math.random() * 59) + 1;
    nextHour.setMinutes(randomMinute);
    nextHour.setSeconds(0);
    nextHour.setMilliseconds(0);
    
    logger.info(`[定时问候] 生成下个小时随机时间: ${nextHour.toLocaleString('zh-CN')}`);
    return nextHour;
  }

  /**
   * 检查指定用户是否已开启定时问候
   * @param {string} userId 用户ID
   * @returns {boolean} 是否开启
   */
  isUserEnabled(userId) {
    const isEnabled = this.userConfigs[userId] === 'on'
    // logger.info(`[定时问候] 检查用户 ${userId} 状态：${isEnabled ? '已开启' : '未开启'}`)
    return isEnabled
  }

  /**
   * 每50秒扫描并执行问候任务
   */
  async scanAndExecuteGreeting() {
    // 自动获取机器人实例（如果还没有的话）
    if (!this.bot) {
      try {
        // 尝试从全局获取机器人实例
        if (typeof Bot !== 'undefined' && Bot.uin) {
          this.bot = Bot;
          // logger.info('[定时问候] 自动获取到机器人实例。');
        } else {
          // logger.info('[定时问候] 机器人实例未就绪，跳过扫描。');
          return;
        }
      } catch (error) {
        // logger.info('[定时问候] 获取机器人实例失败，跳过扫描。');
        return;
      }
    }

    // 重新加载运行配置，确保使用最新状态（静默模式）
    this.loadRunConfig(true);
    
    if (!this.runConfig.shouldSend || !this.runConfig.nextGreetingTime) {
      // logger.info('[定时问候] 无问候计划或时间未设置，跳过扫描。');
      return;
    }

    const now = new Date();
    const scheduledTime = new Date(this.runConfig.nextGreetingTime);
    
    // 检查当前时间的分钟是否匹配
    if (now.getHours() === scheduledTime.getHours() && now.getMinutes() === scheduledTime.getMinutes()) {
      // 防重复发送：检查是否在同一分钟内已经发送过
      const currentTimeKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;
      if (this.lastGreetingTime === currentTimeKey) {
        logger.info(`[定时问候] 该分钟内已发送过问候，跳过重复发送。时间: ${now.toLocaleString('zh-CN')}`);
        return;
      }
      
      logger.info(`[定时问候] 时间匹配！当前时间: ${now.toLocaleString('zh-CN')}, 计划时间: ${scheduledTime.toLocaleString('zh-CN')}`);
      
      // 记录此次问候时间，防止重复
      this.lastGreetingTime = currentTimeKey;
      
      // 执行问候
      await this.executeGreetingToAllUsers();
      
      // 立即更新为下个小时的随机时间
      const nextGreetingTime = this.generateNextHourGreetingTime();
      this.runConfig.nextGreetingTime = this.formatToUTCPlus8(nextGreetingTime);
      this.runConfig.timestamp = this.formatToUTCPlus8(now);
      this.runConfig.hour = nextGreetingTime.getHours();
      this.runConfig.randomMinute = nextGreetingTime.getMinutes();
      this.saveRunConfig();
      
      logger.info(`[定时问候] 已更新下次问候时间为: ${nextGreetingTime.toLocaleString('zh-CN')}`);
    }
  }

  /**
   * 向所有开启用户执行问候
   */
  async executeGreetingToAllUsers() {
    logger.info('[定时问候] 开始向所有用户发送问候。');
    
    const enabledUsers = Object.keys(this.userConfigs).filter(userId => this.userConfigs[userId] === 'on');
    if (enabledUsers.length === 0) {
      logger.info('[定时问候] 没有用户开启，跳过问候发送。');
      return;
    }

    const nowForMessage = new Date();
    const currentTime = nowForMessage.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    
    for (const userId of enabledUsers) {
      // 为每个用户生成个性化的问候消息
      const personalizedGreeting = await this.generateContextualGreeting(userId, currentTime);
      await this.sendActualGreeting(userId, personalizedGreeting);
      logger.info(`[定时问候] 已向用户 ${userId} 发送个性化定时问候。`);
      this.addLogEntry({
        type: 'greeting',
        action: 'scheduledGreetingSent',
        userId: userId,
        messageContent: personalizedGreeting.substring(0, 200) + '...', // 只记录前200字符
        sentAt: this.formatToUTCPlus8(new Date())
      });
    }
    logger.info('[定时问候] 所有用户问候发送完毕。');
  }

  /**
   * 每小时更新问候时间（概率判断）
   */
  async updateHourlyGreetingTime() {
    logger.info('[定时问候] === 每小时更新任务开始 ===');
    
    const now = new Date();
    const currentHour = now.getHours();
    let shouldSend = false;
    let probability = 0;

    // 根据时间段确定概率
    if (currentHour == 7 || currentHour == 22) {
      probability = 0.85;
      shouldSend = Math.random() < probability;
      logger.info(`[定时问候] 当前小时 ${currentHour} 处于 7点或22点时间段，概率 ${probability * 100}%。`);
    }
    else if (currentHour >= 8 && currentHour < 22) {
      probability = 0.20;
      shouldSend = Math.random() < probability;
      logger.info(`[定时问候] 当前小时 ${currentHour} 处于 8-22点时间段，概率 ${probability * 100}%。`);
    }
    else if ((currentHour >= 23 && currentHour <= 23) || (currentHour >= 0 && currentHour < 7)) { 
      probability = 0.05;
      shouldSend = Math.random() < probability;
      logger.info(`[定时问候] 当前小时 ${currentHour} 处于 23-次日7点时间段，概率 ${probability * 100}%。`);
    } else {
      logger.info(`[定时问候] 当前小时 ${currentHour} 不在任何预设问候时间段内，不发送问候。`);
      shouldSend = false;
    }

    // 生成这个小时的随机分钟数
    let randomMinute = shouldSend ? Math.floor(Math.random() * 59) + 1 : 0;
    
    const scheduledTime = new Date();
    scheduledTime.setHours(currentHour);
    scheduledTime.setMinutes(randomMinute);
    scheduledTime.setSeconds(0);
    scheduledTime.setMilliseconds(0);

    // 如果计划时间已经过去，则安排到下一个小时
    if (scheduledTime.getTime() <= now.getTime()) {
      scheduledTime.setHours(currentHour + 1);
      logger.info(`[定时问候] 原定时间已过，调整到下一小时：${scheduledTime.toLocaleString('zh-CN')}`);
    }

    // 更新运行配置
    this.runConfig = {
      timestamp: this.formatToUTCPlus8(now),
      randomMinute: scheduledTime.getMinutes(),
      shouldSend: shouldSend,
      hour: scheduledTime.getHours(),
      nextGreetingTime: shouldSend ? this.formatToUTCPlus8(scheduledTime) : null
    };

    this.addLogEntry({
      type: 'probabilityCheck',
      userId: 'global',
      hour: currentHour,
      randomMinute: randomMinute,
      probability: probability,
      passed: shouldSend,
      scheduled: shouldSend,
      currentTime: this.formatToUTCPlus8(now)
    });

    this.saveRunConfig();
    logger.info(`[定时问候] 本小时问候计划: ${shouldSend ? `将在 ${scheduledTime.toLocaleString('zh-CN')} 发送问候` : '不发送问候'}`);
    logger.info('[定时问候] === 每小时更新任务结束 ===');
  }

  /**
   * 获取用户的对话历史上下文
   * @param {string} targetQQ 目标QQ号
   * @returns {Promise<object>} 返回对话上下文信息
   */
  async getUserConversationContext(targetQQ) {
    try {
      // 创建一个模拟的事件对象来获取对话上下文
      const mockEvent = {
        isPrivate: true,
        user_id: targetQQ,
        sender: { user_id: targetQQ },
        isGroup: false
      }
      
      // 检查是否存在对话历史
      const conversationKey = `CHATGPT:CONVERSATIONS:${targetQQ}`
      const conversationData = await redis.get(conversationKey)
      
      if (conversationData) {
        const conversation = JSON.parse(conversationData)
        logger.info(`[定时问候] 用户 ${targetQQ} 存在对话历史，消息数: ${conversation.messages?.length || 0}`)
        
        // 获取最近的几条消息作为上下文
        const recentMessages = conversation.messages?.slice(-5) || []
        const lastUserMessage = recentMessages
          .filter(msg => msg.role === 'user')
          .pop()?.content || '无最近消息'
        
        const lastAssistantMessage = recentMessages
          .filter(msg => msg.role === 'assistant')
          .pop()?.content || '无AI回复'
        
        return {
          hasHistory: true,
          messageCount: conversation.messages?.length || 0,
          lastUserMessage: lastUserMessage.substring(0, 100), // 截取前100字符
          lastAssistantMessage: lastAssistantMessage.substring(0, 100),
          recentMessages,
          conversationAge: conversation.ctime ? new Date(conversation.ctime) : null
        }
      } else {
        logger.info(`[定时问候] 用户 ${targetQQ} 无对话历史`)
        return {
          hasHistory: false,
          messageCount: 0,
          lastUserMessage: null,
          lastAssistantMessage: null,
          recentMessages: [],
          conversationAge: null
        }
      }
    } catch (error) {
      logger.error(`[定时问候] 获取用户 ${targetQQ} 对话上下文失败:`, error)
      return {
        hasHistory: false,
        messageCount: 0,
        lastUserMessage: null,
        lastAssistantMessage: null,
        recentMessages: [],
        conversationAge: null,
        error: error.message
      }
    }
  }

  /**
   * 根据用户上下文生成个性化问候消息
   * @param {string} targetQQ 目标QQ号
   * @param {string} currentTime 当前时间
   * @returns {Promise<string>} 返回个性化的问候消息
   */
  async generateContextualGreeting(targetQQ, currentTime) {
    const context = await this.getUserConversationContext(targetQQ)
    
    let greetingMessage = this.greetingMessageTemplate.replace('{currentTime}', currentTime)
    
    // 如果有对话历史，添加上下文信息
    if (context.hasHistory && context.messageCount > 0) {
      let contextualInfo = `\n\n【上下文信息】`
      contextualInfo += `\n- 历史对话次数: ${context.messageCount}`
      
      if (context.conversationAge) {
        const daysSinceStart = Math.floor((new Date() - context.conversationAge) / (1000 * 60 * 60 * 24))
        contextualInfo += `\n- 对话开始于: ${daysSinceStart}天前`
      }
      
      if (context.lastUserMessage) {
        contextualInfo += `\n- 用户最后说: "${context.lastUserMessage}${context.lastUserMessage.length > 97 ? '...' : ''}"`
      }
      
      if (context.lastAssistantMessage) {
        contextualInfo += `\n- AI最后回复: "${context.lastAssistantMessage}${context.lastAssistantMessage.length > 97 ? '...' : ''}"`
      }
      
      contextualInfo += `\n\n请根据这些历史对话信息，生成更有针对性和连续性的问候。可以询问之前聊天中提到的话题，或者自然地延续之前的对话内容。`
      
      greetingMessage += contextualInfo
      logger.info(`[定时问候] 为用户 ${targetQQ} 生成了包含上下文的个性化问候`)
    } else {
      logger.info(`[定时问候] 用户 ${targetQQ} 无对话历史，使用标准问候模板`)
    }
    
    return greetingMessage
  }

  /**
   * 设置用户定时问候状态
   * @param {string} userId 用户ID
   * @param {string} status 状态 ('on' 或 'off')
   */
  setUserStatus(userId, status) {
    logger.info(`[定时问候] 设置用户 ${userId} 状态为：${status}`)
    this.userConfigs[userId] = status
    this.saveConfig()
  }

  /**
   * 监听用户活动，记录消息时间
   * @param {object} e 消息事件对象
   */
  async monitorUserActivity(e) {
    // 只监听私聊消息，且用户已开启定时问候功能
    if (e.isPrivate && this.isUserEnabled(e.sender.user_id.toString())) {
      // 如果不是定时问候相关的命令，则记录用户活动
      // 增加对 e.msg 的类型检查，确保其为字符串再调用 startsWith
      if (!(typeof e.msg === 'string' && (e.msg.startsWith('#开启定时问候') || e.msg.startsWith('#关闭定时问候')))) {
        const userId = e.sender.user_id.toString()
        
        // 检查用户是否在等待状态中
        if (this.messageWaitRecords[userId]) {
          logger.info(`[定时问候] 用户 ${userId} 在等待期间回复了消息，取消预定的询问问候`)
          
          // 记录取消事件到日志
          this.addLogEntry({
            type: 'waitingMessage',
            action: 'waitingInquiryCancelled',
            userId: userId,
            reason: 'userRepliedDuringWait',
            cancelledAt: this.formatToUTCPlus8(new Date())
          })
          
          // 清除等待记录，取消询问问候
          delete this.messageWaitRecords[userId]
          this.saveMessageWaitRecords()
        }
        
        // 用户回复后，重新启动等待计时器
        this.startWaitTimerForUser(userId)
      }
    }
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

    // 立即为当前发送命令的用户发送一条问候 (无视其他条件) - 已注释
    // const nowForMessage = new Date()
    // const currentTime = nowForMessage.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    // const greetingMessage = this.greetingMessageTemplate.replace('{currentTime}', currentTime);
    // await this.sendActualGreeting(userId, greetingMessage)
    // logger.info(`[定时问候] 已向用户 ${userId} 立即发送问候 (通过 startGreeting 命令触发)。`)
    // this.addLogEntry({
    //   type: 'greeting',
    //   action: 'immediateGreeting',
    //   userId: userId,
    //   messageContent: greetingMessage,
    //   sentAt: this.formatToUTCPlus8(new Date()) // 保存为UTC+8时间
    // })

    // 显示下次问候时间
    let nextScheduledTimeDisplay = "下次问候时间将根据每小时随机确定";
    this.loadRunConfig(); // 确保加载最新配置
    if (this.runConfig.shouldSend && this.runConfig.nextGreetingTime) {
        const scheduledDate = new Date(this.runConfig.nextGreetingTime);
        nextScheduledTimeDisplay = `下次问候预计时间为：${scheduledDate.toLocaleString('zh-CN')}。`;
    }

    if (wasEnabled) {
      e.reply(`您已经开启了定时问候功能。`, true)
    } else {
      e.reply(`定时问候已开启`, true)
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
    logger.info(`[定时问候] 用户 ${userId} 已禁用定时问候。`)
    
    const enabledUsers = Object.values(this.userConfigs).filter(status => status === 'on')
    logger.info(`[定时问候] 剩余开启用户数：${enabledUsers.length}`)
    
    // 注意：定时器系统保持运行，只是不会给关闭的用户发送消息
    // 如果需要完全停止系统，可以取消下面的注释
    // if (enabledUsers.length === 0) {
    //   // 如果没有用户开启，停止所有定时器
    //   if (this.scanInterval) {
    //     clearInterval(this.scanInterval);
    //     this.scanInterval = null;
    //     logger.info('[定时问候] 50秒扫描定时器已停止。');
    //   }
    //   if (this.hourlyInterval) {
    //     clearInterval(this.hourlyInterval);
    //     this.hourlyInterval = null;
    //     logger.info('[定时问候] 每小时更新定时器已停止。');
    //   }
    //   // 清除心跳定时器
    //   if (this.heartbeatInterval) {
    //     clearInterval(this.heartbeatInterval);
    //     this.heartbeatInterval = null;
    //     logger.info('[定时问候] 清除了心跳日志定时器。');
    //   }
    //   this.bot = null // 清除机器人实例
    //   // 清空运行配置文件
    //   this.runConfig = {};
    //   this.saveRunConfig();
    //   logger.info('[定时问候] greet_run.json 已清空。');
    // } else {
    //   logger.info('[定时问候] 定时器系统仍在运行，因为仍有其他用户开启。')
    // }
    
    logger.info('[定时问候] 定时器系统继续运行，但不会向您发送问候。');
    e.reply('定时问候已关闭', true) // 回复用户定时任务已关闭
    logger.info(`[定时问候] 用户 ${userId} 的定时问候已成功关闭。`)
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
      logger.error("[定时问候] 机器人实例未设置，无法发送问候消息。")
      return
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
      // 关键：重写 reply 方法，使其能够通过机器人实例发送私聊消息
      reply: async (msg, quote, data) => {
        logger.info(`[定时问候] DummyEvent Reply 触发，准备通过bot.pickFriend().sendMsg发送至 ${targetQQ}。`)
        try {
          // 使用 this.bot.pickFriend(targetQQ).sendMsg(msg) 来发送私聊消息
          await this.bot.pickFriend(targetQQ).sendMsg(msg)
          logger.info(`[定时问候] 已通过bot.pickFriend().sendMsg发送消息至 ${targetQQ}: ${typeof msg === 'string' ? msg.substring(0, 100) : '[复杂消息]'}`)
        } catch (error) {
          logger.error(`[定时问候] 发送消息至 ${targetQQ} 失败:`, error)
        }
      },
      // 添加运行时处理器支持（如果需要的话）
      runtime: {
        handler: {
          has: () => false,
          call: () => null
        }
      }
    }

    const chat = new chatgpt(dummyEvent) // 创建 chatgpt 实例
    chat.e = dummyEvent // 显式设置 chatgpt 实例的 e 属性，确保 chat.js 内部的 this.e 有效
    try {
      await chat.abstractChat(dummyEvent, message, 'gemini')
      logger.info(`[定时问候] abstractChat 调用完成为 ${targetQQ}。`)
      
      // AI回复后，根据参数决定是否更新用户的消息时间
      if (recordTime) {
        this.startWaitTimerForUser(targetQQ)
      } else {
        logger.info(`[定时问候] 本次为等待问候，不记录机器人回复时间以避免循环。`)
      }
    } catch (error) {
      logger.error(`[定时问候] 调用 abstractChat 为 ${targetQQ} 时出错:`, error)
    }
  }

}

export default Greet
