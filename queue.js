require('dotenv').config();

const Redis = require('ioredis');
const redis = new Redis({
    port: 6379,
    host: process.env.REDIS_HOST,
});

const stream = 'CoolStreamName';
const group =  'CoolGroupName';

async function ensuregroup(id = '$') {
    try{
        await redis.xgroup('CREATE', stream, group, id, 'MKSTREAM');
        console.log(`Consumer group ${group} created`);
    } catch(err){
        if(err.message.includes('BUSYGROUP')){
            console.log(`Consumer group ${group} already exists`);
        }else{
            throw err;
        }
    } 


}

module.exports = ensuregroup