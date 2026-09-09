const connectDB = require("./connectDB");
const queue = require("./queue");
const Job = require("./models/job");
const Content = require("./models/content");
const RowError = require("./models/error");
const storage = require("./storage");
let running = true;
let recovered = true; // to prevent double claiming a row
const { parse } = require('csv-parse');
const contentSchema = require("./models/zod");

async function main() {
    await connectDB()
    await Content.syncIndexes()
    await RowError.syncIndexes()
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


async function flushContent(rows){

    const operations = rows.map(d =>({
        updateOne: {
            filter: {customer_id: d.customer_id},
            update: {
                $set: d
            },
            upsert: true
        }
    }))

    try{
        
        const write = await Content.bulkWrite(operations, {ordered: false})
    
        const ok = write.upsertedCount + write.matchedCount
        const failed = 0
    
        return {ok: ok, failed: failed}  
    }catch(err){

        const ok = err.result.upsertedCount + err.result.matchedCount
        const failed = err.writeErrors.length
        
        return {ok: ok, failed: failed}  
        
    }
}

async function flushRowErrors(jobId, result_fail){
    const docs = result_fail.map(e => ({ ...e, importId: jobId}))
    try{
    
        const inserted = await RowError.insertMany(docs, {ordered: false})

        const ok = inserted.length
        const failed = docs.length - inserted.length

        return {ok: ok, failed: failed}
    }catch(err){
        
        const ok = err.result.insertedCount
        const failed = err.writeErrors.length
        return {ok: ok, failed: failed}
    }
}

async function processJob(job, recovered = false){
    let claimed = '';

    let result_pass = [];
    let result_fail = [];

    let rowsOk = 0;
    let rowsFailed = 0;
    let totalRows = 0;

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

    const parser = parse({columns: true, info: true, skip_records_with_error: true})

    parser.on('skip', (e)=>{
        totalRows += 1
        result_fail.push({importId: job.jobId, row: e.lines, reason: e.code, raw: e.record})
    })

    s.pipe(parser)
    
 



    for await (const row of parser){ 
        totalRows++
        if(totalRows % 10000 === 0) console.log(totalRows, process.memoryUsage().rss)
        
        
        const result = contentSchema.safeParse(row.record)

        
        if(result_pass.length === 1000){
            console.log(`result_pass: ${result_pass.length}`)

            
            const flushedContent = await flushContent(result_pass)
            rowsOk += flushedContent.ok

            result_pass = []
            
        }
        
        if(result_fail.length === 1000){
            console.log(`result_fail: ${result_fail.length}`) 

            await flushRowErrors(job.jobId, result_fail)
            
            rowsFailed += result_fail.length

            result_fail = []
        }

        
        if(result.success){

            result_pass.push(result.data)
        }else{
            console.log(result.error.issues)
            result_fail.push({importId: job.jobId, row: row.info.lines, reason: result.error.issues.map(i => `${i.path}: ${i.message}`).join('; '), raw: row.record})
        }
    }

    if(result_pass.length > 0){
        console.log(`result_pass: ${result_pass.length}`)

        const flushedContent = await flushContent(result_pass)
        
        rowsOk += flushedContent.ok

        result_pass = []
    }
    
    if(result_fail.length > 0){
        console.log(`result_fail: ${result_fail.length}`)
        
        await flushRowErrors(job.jobId, result_fail)
        
        rowsFailed += result_fail.length

        result_fail = []
    }

    await Job.transition(job.jobId, 'done', {rowsOk, rowsFailed, totalRows})

    console.log(totalRows)
    await queue.ack(job.entryId) 
}

main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});