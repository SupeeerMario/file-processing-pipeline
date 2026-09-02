const connectDB = require("./connectDB");
const queue = require("./queue");
const Job = require("./models/job");
const storage = require("./storage");
let running = true;
let recovered = true; // to prevent double claiming a row

async function main() {
    await connectDB()
    await queue.ensuregroup()
    const pending = await queue.consume('0');
    if(pending){

        await processJob(pending, recovered)
        console.log(`deleting pending pel: ${pending.entryId}`)
    }


    while(running){
        const job = await queue.consume()
        if(!job){

            continue

        }else{

            await processJob(job)
        }

    }


}


async function processJob(job, recovered = false){
    let claimed = '';
    if(!recovered){

        claimed = await Job.transition(job.jobId, 'processing');
    }else{
        
        claimed = await Job.processing(job.jobId)
    }

    if(claimed === 0){
        console.log('No pending operations')

        await queue.ack(job.entryId) 
        return 
    }

    const doc = await Job.findById(job.jobId);
    const s = await storage.get(doc.storageKey);
    let total = 0;

    for await (const chunk of s) total += chunk.length
    console.log(total)
    await queue.ack(job.entryId) 
}

main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});