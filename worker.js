const connectDB = require("./connectDB");
const queue = require("./queue");
let running = true;

async function main() {
    await connectDB()
    await queue.ensuregroup()
    const pending = await queue.consume('0');
    if(pending){

        console.log(`deleting pending pel: ${pending.entryId}`)
        await queue.ack(pending.entryId)
    }


    while(running){
        const job = await queue.consume()
        if(!job){

            continue

        }else{
            await queue.ack(job.entryId) 
        }

    }


}


main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});