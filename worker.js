const connectDB = require("./connectDB");
const queue = require("./queue");
const Job = require("./models/job");
const Content = require("./models/content");
const RowError = require("./models/error");
const storage = require("./storage");

let running = true;
process.on('SIGTERM', () => { running = false })

let recovered = true; // to prevent double claiming a row
const { parse } = require('csv-parse');
const contentSchema = require("./models/zod");
const mongoose = require('mongoose');


async function main() {
    await connectDB()
    await Content.syncIndexes()
    await RowError.syncIndexes()
    await queue.ensuregroup()
    const pending = await queue.consume('0');
    if(pending){

        await runJob(pending, recovered)
        console.log(`deleting pending pel: ${pending.entryId}`)
    }


    while(running){
        const job = await queue.consume()
        if(!job){
            
            const reaped = await queue.reap()
            if(reaped){
                await runJob(reaped, recovered)
            }
                
        }else{
            await runJob(job)
        }

    }

    await queue.close()
    await mongoose.disconnect()
    process.exit(0)


}


async function runJob(job, recovered){
    try{

        await processJob(job, recovered)
    }catch(err){

        const action = classify(err)
            if(action === "permanent"){
                
                await Job.transition(job.jobId, 'dead_lettered', { error: err.message })
                await queue.deadLetter(job.entryId, job.jobId, `error name : ${err.name}, error desc: ${err.message}`)

            }else{

                const n = await queue.deliveryCount(job.entryId) 
                if (n >= 5){
                    
                    await Job.transition(job.jobId, 'dead_lettered', { error: err.message })
                    await queue.deadLetter(job.entryId, job.jobId, `error name : ${err.name}, error desc: ${err.message}`)
                }
            }

        console.log(`job: ${job.jobId}, caused error: ${action}`)
    }
}



const TRANSIENT_NAMES = ['TimeoutError', 'NetworkingError', 'MongoNetworkError','MongoServerSelectionError', 'MongoNotConnectedError'];
const TRANSIENT_CODES = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'];
const PERMANENT_NAMES = ['NoSuchKey', 'NoSuchBucket', 'AccessDenied', 'InvalidAccessKeyId', 'SignatureDoesNotMatch', 'ValidationError', 'CastError', 'TypeError', 'ReferenceError'];

function classify(error){
    if(typeof error.hasErrorLabel === 'function' && (error.hasErrorLabel('TransientTransactionError') || error.hasErrorLabel('UnknownTransactionCommitResult'))){
        return 'transient'
    }else if(TRANSIENT_NAMES.includes(error.name)){
        return 'transient'
    }else if(TRANSIENT_CODES.includes(error.code)){
        return 'transient'
    }else if(PERMANENT_NAMES.includes(error.name)){
        return 'permanent'
    }else{
        console.log(`error_name: ${error.name}, and error_code: ${error.code}`)
        return 'transient'
    }
}


async function flushContent(rows, jobId, chunkCounter, rowsOkSoFar){
    let ok, failed = 0;


    const operations = rows.map(d =>({
        updateOne: {
            filter: {importId: d.importId, row: d.row},
            update: {
                $set: d
            },
            upsert: true
        }
    }))

        
    const session = await mongoose.startSession()



        
    try{
        await session.withTransaction(async () => {
        
            const write = await Content.bulkWrite(operations, {ordered: false, session})
            ok = write.upsertedCount + write.matchedCount
            failed = 0
            await Job.updateOne({_id: jobId}, {$set: {lastCommittedChunk: chunkCounter, rowsOk: rowsOkSoFar + ok}}, {session})
            
        })
            
        return {ok: ok, failed: failed}  
        
    }catch(err){
            
        console.error({error: err})
        throw err
        
    
    }finally{session.endSession()}
            
}

async function flushRowErrors(jobId, result_fail){
    const docs = result_fail.map(e => ({ ...e, importId: jobId}))
    
    const operations = docs.map(d =>({
        updateOne: {
            filter: {importId: d.importId, row: d.row},
            update: {
                $set: d
            },
            upsert: true
        }
    }))
    
    try{
    
        const inserted = await RowError.bulkWrite(operations, {ordered: false})

        const ok = inserted.upsertedCount + inserted.matchedCount
        const failed = 0

        return {ok: ok, failed: failed}
    }catch(err){
        
        const ok = err.result.upsertedCount + err.result.matchedCount
        const failed = err.writeErrors.length
        return {ok: ok, failed: failed}
    }
}

async function processJob(job, recovered = false){
    let claimed = '';

    let result_pass = [];
    let result_fail = [];

 

    let chunkCounter = 0;

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


    let rowsOk = doc.rowsOk;
    let rowsFailed = doc.rowsFailed;
    let totalRows = 0;
    
    const s = await storage.get(doc.storageKey);

    const parser = parse({columns: true, info: true, skip_records_with_error: true})

    parser.on('skip', (e)=>{
        totalRows += 1
        result_fail.push({importId: job.jobId, row: e.lines, reason: e.code, raw: e.record})
    })

    s.pipe(parser)
    
 



    for await (const row of parser){ 
        
        if(!running) {
        console.log(`SIGTERM: releasing job ${job.jobId} at chunk ${chunkCounter}, row ${totalRows} — not acked`)           
        return
        }
        
        totalRows++
        if(totalRows % 10000 === 0) console.log(totalRows, process.memoryUsage().rss)
        
        
        const result = contentSchema.safeParse(row.record)

        
        if(result_pass.length === 1000){
            console.log(`result_pass: ${result_pass.length}`)

            chunkCounter += 1

            if(chunkCounter <= doc.lastCommittedChunk){

                result_pass = []

            }else{

                const flushedContent = await flushContent(result_pass, job.jobId, chunkCounter, rowsOk)
                rowsOk += flushedContent.ok
                result_pass = []

            }

            
        }
        
        if(result_fail.length === 1000){
            console.log(`result_fail: ${result_fail.length}`) 

            await flushRowErrors(job.jobId, result_fail)
            
            rowsFailed += result_fail.length

            result_fail = []

        }

        
        if(result.success){

            result_pass.push({ ... result.data, importId: job.jobId, row: row.info.lines})
        }else{
            console.log(result.error.issues)
            result_fail.push({importId: job.jobId, row: row.info.lines, reason: result.error.issues.map(i => `${i.path}: ${i.message}`).join('; '), raw: row.record})
        }
    }

    if(result_pass.length > 0){
        console.log(`result_pass: ${result_pass.length}`)

        chunkCounter += 1

        if(chunkCounter <= doc.lastCommittedChunk){

            result_pass = []

        }else{

            const flushedContent = await flushContent(result_pass, job.jobId, chunkCounter, rowsOk)
            rowsOk += flushedContent.ok
            result_pass = []

        }

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