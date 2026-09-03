const connectDB = require("./connectDB");
const queue = require("./queue");
const Job = require("./models/job");
const Content = require("./models/content");
const storage = require("./storage");
let running = true;
let recovered = true; // to prevent double claiming a row
const { parse } = require('csv-parse');
const contentSchema = require("./models/zod");

async function main() {
    await connectDB()
    await Content.syncIndexes()
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
    let bytes = 0;

    const parser = parse({columns: true, info: true, skip_records_with_error: true})

    parser.on('skip', (e)=>{
        result_fail.push({row: e.lines, reason: e.code, raw: e.record})
    })

    s.pipe(parser)
    
 
    let result_pass = [];
    let result_fail = [];

    for await (const row of parser){ 
        bytes++
        if(bytes % 10000 === 0) console.log(bytes, process.memoryUsage().rss)
        
        
        const result = contentSchema.safeParse(row.record)

        
        if(result_pass.length === 1000){
            console.log(`result_pass: ${result_pass.length}`)
            result_pass = []
        }
        
        if(result_fail.length === 1000){
            console.log(`result_fail: ${result_fail.length}`)
            result_fail = []
        }

        
        if(result.success){

            result_pass.push(result.data)
        }else{
            console.log(result.error.issues)
            result_fail.push({row: row.info.lines, reason: result.error.issues.map(i => `${i.path}: ${i.message}`).join('; '), raw: row.record})
        }
    }

    if(result_pass.length > 0){
        console.log(`result_pass: ${result_pass.length}`)
        result_pass = []
    }
    
    if(result_fail.length > 0){
        console.log(`result_fail: ${result_fail.length}`)
        result_fail = []
    }



    console.log(bytes)
    await queue.ack(job.entryId) 
}

main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});