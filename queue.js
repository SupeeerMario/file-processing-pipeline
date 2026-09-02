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

async function publish(jobId){

    const messegeId = await redis.xadd(
        stream,
        'MAXLEN',
        '1000',
        '*',
        'jobId',
        jobId
    );
    
    console.log(`Published job ${jobId} with messege id ${messegeId}`)
}



async function consume(from = '>'){
    
    const result = await redis.xreadgroup('GROUP', group, process.env.CONSUMER_NAME, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', stream, from)
    console.log(JSON.stringify(result))

    if(result === null){
        console.log('No new work')
        return
    }


    const entries = result[0][1];
    
    if(entries.length === 0){
        console.log('No entries to delete');
        return
    }

    const entryId = entries[0][0];
    const job = entries[0][1];
    const jobId = job[1]

    return {entryId, jobId}
}


async function ack(entryId){
    const res = await redis.xack(stream, group, entryId);
    console.log(res)
    return res
}

module.exports = {ensuregroup, publish, consume, ack}