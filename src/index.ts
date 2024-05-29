// a discord bot that transfers DM to a channel

import * as util from 'util';

import { Client, GatewayIntentBits, Message, Events, Collection, Interaction, SlashCommandBuilder, CommandInteraction, Guild, GuildBasedChannel, PermissionFlagsBits, Partials, PartialMessage, User, Snowflake } from 'discord.js';
import * as fs from 'fs';
import * as path from 'path';

import * as sqlite3 from 'sqlite3';


function main() {
  let profile = process.argv[2] || 'default_profile';
  new Bot(profile);
}


class Bot {
  config: Config;
  client: Client;
  DB: DB;
  constructor(profile: string){
    this.config = Config.getConfig(profile);
    this.DB = DB.getDB(profile);

    this.client = new Client({intents: [
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.MessageContent
    ],
    partials: [
      Partials.Channel,
      Partials.Message,
      Partials.User,
      Partials.GuildMember,
    ]});

    this.client.once(Events.ClientReady, readyClient => {
      console.log(`Ready! Logged in as ${readyClient.user.tag}, profile: ${profile}`);
    });

    this.client.on(Events.InteractionCreate, interaction => {
      if (interaction.isCommand()) {
        this.onCommand(interaction);
        return;
      }
    });

    this.client.on(Events.MessageCreate, message => {
      if (message.author.bot) {
        return;
      }
      this.onMessage(message);
    });

    this.client.on(Events.MessageDelete, message => {
      this.onMessageDelete(message);
    });

    this.client.login(this.config.token);
  }

  onCommand(interaction: CommandInteraction){
  }
  
  onMessage(message: Message){
    if (!message.channel.isDMBased()) {
      return;
    }
    this.trySendMessage(message.id, message.content, message.author).catch(console.error).then();
  }

  onMessageDelete(message: Message | PartialMessage){
    if (!message.channel.isDMBased()) {
      return;
    }
    this.deleteMessageByOriginalId(message.id, message.author?.id ?? "_").then((result)=>{}).catch(console.error);
  }



  async trySendMessage(original_id: Snowflake, message: string, author: User){
    let channel = await this.client.channels.fetch(this.config.channel);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      author.send('送信先チャンネルが見つかりませんでした').catch(console.error);
      return;
    }
    let guild = channel.guild;
    let member = await guild.members.fetch(author.id);
    if (!member?.permissionsIn(channel).has(PermissionFlagsBits.SendMessages)) {
      author.send('メッセージ送信権限がありません').catch(console.error);
      return;
    }
    let data = await channel.send(message);
    this.DB.addMessage(original_id, data.id, author.id, message);
  }

  async deleteMessageByOriginalId(original_id: string, author_id: string){
    let data = await this.DB.getMessageByOriginalId(original_id);
    if (data.length == 0) {
      return DeleteResult.NOT_EXIST;
    }
    if (data[0].author_id != author_id) {
      return DeleteResult.NOT_OWNER;
    }

    
    let channel = this.client.channels.resolve(this.config.channel);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      console.error('channel not found');
      return;
    }
    
    let message = await channel.messages.fetch(data[0].message_id);
    await message.delete();
    await this.DB.removeMessageByOriginalId(original_id, author_id);
  }
}


function profileDir(profile: string): string{
  return path.join(__dirname, "../", profile);
}

function pathConfig(profile: string): string{
  return path.join(profileDir(profile), 'config.json');
}

function pathDB(profile: string): string{
  return path.join(profileDir(profile), 'db.sqlite');
}

class Config {
  token: string;
  channel: Snowflake;
  constructor(token: string, channel: Snowflake){
    this.token = token;
    this.channel = channel;
  }

  static fromJSON(json: string){
    try {
      let obj = JSON.parse(json);
      return new Config(obj.token, obj.channel);
    } catch (e) {
      console.error(e);
      return new Config("", "");
    }
  }
  
  static getConfig(profile: string): Config{
    let dir = profileDir(profile);
    if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory()) {
      console.error('no directory. creating');
      fs.mkdirSync(dir);
    }
    if (!fs.existsSync(pathConfig(profile))) {
      console.error('no config file. creating');
      new Config("", "").write(profile);
    }
    return Config.fromJSON(fs.readFileSync(pathConfig(profile), 'utf8'));
  }

  write(profile: string){
    fs.writeFileSync(pathConfig(profile), JSON.stringify(this, null, 2));
  }
}

const DeleteResult = {
  SUCCESS: 0,
  NOT_EXIST: 1,
  NOT_OWNER: 2,
  FAILED: 3
} as const;
type DeleteResult = typeof DeleteResult[keyof typeof DeleteResult];

function messageDeleteResult(err: DeleteResult): string{
  switch (err) {
    case DeleteResult.SUCCESS:
      return 'メッセージを削除しました';
    case DeleteResult.NOT_EXIST:
      return 'メッセージが見つかりません';
    case DeleteResult.NOT_OWNER:
      return 'あなたは送信者ではありません';
    default:
      return '削除に失敗しました';
  }
}

interface MessageLogData {
  message_id: string;
  author_id:  string;
  message:    string;
}

class DB {
  sqlitedb: sqlite3.Database;

  constructor(sqlitedb: sqlite3.Database){
    this.sqlitedb = sqlitedb;
  }

  static getDB(profile: string): DB{
    let sqlitedb = new sqlite3.Database(pathDB(profile));
    sqlitedb.serialize(() => {
      sqlitedb.run('CREATE TABLE IF NOT EXISTS messages (original_id TEXT PRIMARY KEY, message_id TEXT , author_id TEXT, message TEXT)');
    });
    return new DB(sqlitedb);
  }
  
  async addMessage(original_id: string, message_id: string, author_id: string, message: string){
    return util.promisify((c)=>this.sqlitedb.run('INSERT INTO messages (original_id, message_id, author_id, message) VALUES (?, ?, ?, ?)', [original_id, message_id, author_id, message], c))();
  }

  async removeMessageByOriginalId(original_id: string, author_id: string): Promise<DeleteResult>{
    await util.promisify((c)=>this.sqlitedb.run('DELETE FROM messages WHERE original_id = ?', [original_id], c))();
    return DeleteResult.SUCCESS;
  }

  async removeMessageByMessageId(message_id: string, author_id: string): Promise<DeleteResult>{
    await util.promisify((c)=>this.sqlitedb.run('DELETE FROM messages WHERE message_id = ?', [message_id], c))();
    return DeleteResult.SUCCESS;
  }

  async getAuthor(message_id: string): Promise<string>{
    let result = await util.promisify<MessageLogData[]>((c)=>this.sqlitedb.all<MessageLogData>('SELECT author_id FROM messages WHERE message_id = ?', [message_id], c))();
    if (result.length == 0) {
      return "";
    }
    return result[0].author_id;
  }

  async getMessageByOriginalId(original_id: string): Promise<MessageLogData[]>{
    return util.promisify<MessageLogData[]>((c)=>this.sqlitedb.all('SELECT * FROM messages WHERE original_id = ?', [original_id], c))();
  }
}

main();
