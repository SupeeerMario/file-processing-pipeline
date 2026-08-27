const connectDB = require("./connectDB");
const ensuregroup = require("./queue");


async function main() {
await connectDB()
await ensuregroup()


}


main().catch(err => {
    console.log('worker crashed', err)
    process.exit(1);
});