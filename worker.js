const connectDB = require("./connectDB");
const queue = require("./queue");


async function main() {
await connectDB()
await queue.ensuregroup()


}


main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});