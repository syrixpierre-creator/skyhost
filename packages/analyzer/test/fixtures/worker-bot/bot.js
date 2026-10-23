const { Client } = require('discord.js');
new Client({ intents: [] }).login(process.env.DISCORD_TOKEN);
