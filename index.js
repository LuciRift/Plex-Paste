const fs = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));
const axios = require('axios');
const color = require('ansi-colors');
const botVersion = require('./package.json');
const path = require('path');

console.log(`${color.yellow(`Starting product, this can take a while..`)}`)

const version = Number(process.version.split('.')[0].replace('v', ''));
if (version < 18) {
  console.log(`${color.red(`[ERROR] Plex Paste requires a NodeJS version of 18 or higher!\nYou can check your NodeJS by running the "node -v" command in your terminal.`)}`);

  console.log(`${color.blue(`\n[INFO] To update Node.js, follow the instructions below for your operating system:`)}`);
  console.log(`${color.green(`- Windows:`)} Download and run the installer from ${color.cyan(`https://nodejs.org/`)}`);
  console.log(`${color.green(`- Ubuntu/Debian:`)} Run the following commands in the Terminal:`);
  console.log(`${color.cyan(`  - sudo apt update`)}`);
  console.log(`${color.cyan(`  - sudo apt upgrade nodejs`)}`);
  console.log(`${color.green(`- CentOS:`)} Run the following commands in the Terminal:`);
  console.log(`${color.cyan(`  - sudo yum update`)}`);
  console.log(`${color.cyan(`  - sudo yum install -y nodejs`)}`);

  let logMsg = `\n\n[${new Date().toLocaleString()}] [ERROR] Plex Paste requires a NodeJS version of 18 or higher!`;
  fs.appendFile("./logs.txt", logMsg, (e) => { 
    if(e) console.log(e);
  });

  process.exit()
}

const { Collection, Client, Discord, ActionRowBuilder, ButtonBuilder, GatewayIntentBits } = require('discord.js');
const client = new Client({ 
  restRequestTimeout: 60000,
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.GuildMembers, 
    GatewayIntentBits.GuildPresences, 
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ] 
});
exports.client = client;


require("./app.js");


async function uploadToHaste(textToUpload) {
    try {
      const response = await axios.post('https://paste.plexdevelopment.net/documents', textToUpload);
      return response.data.key;
    } catch (error) {
      if (error.response) {
        console.error('Error uploading to Haste-server. Status:', error.response.status);
        console.error('Response data:', error.response.data);
      } else {
        console.error('Error uploading to Haste-server:', error.message);
      }
      return null;
    }
  }
  
  const filePath = './logs.txt';
  const maxLength = 300;
  
  async function handleAndUploadError(errorType, error) {
    console.log(error);
  
    const errorPrefix = `[${new Date().toLocaleString()}] [${errorType}] [v${botVersion.version}]`;
    const errorMsg = `\n\n${errorPrefix}\n${error.stack}`;
    fs.appendFile("./logs.txt", errorMsg, (e) => {
      if (e) console.log(e);
    });
  
    fs.readFile(filePath, 'utf8', (err, data) => {
      if (err) {
        console.error('Error reading file:', err.message);
        return;
      }
  
      const lines = data.split('\n');
      const truncatedContent = lines.length > maxLength ? lines.slice(-maxLength).join('\n') : data;
  
      uploadToHaste(truncatedContent).then(key => {
        if (key) {
          const hasteURL = `https://paste.plexdevelopment.net/${key}`;
          console.log(`${color.green.bold(`[v${botVersion.version}]`)} ${color.red(`If you require assistance, create a ticket in our Discord server and share this link:`)} ${color.yellow(hasteURL)}\n\n`);
        } else {
          console.log('Paste Upload failed.');
        }
      });
    });
  }

  process.on('warn', async (error) => {
    handleAndUploadError('WARN', error);
  });
  
  process.on('error', async (error) => {
    handleAndUploadError('ERROR', error);
  });
  
  process.on('unhandledRejection', async (error) => {
    handleAndUploadError('unhandledRejection', error);
  });
  
  process.on('uncaughtException', async (error) => {
    handleAndUploadError('uncaughtException', error);
  });