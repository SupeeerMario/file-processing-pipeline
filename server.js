require('dotenv').config();

const express = require('express');
const connectDB = require('./connectDB');
const ensureBucket = require('./storage');
const app = express();
const port = process.env.SERVER_PORT;

connectDB().then(ensureBucket).catch(err =>{
    console.log('error while creating bucket', err);
    process.exit(1);
}).then(()=> app.listen(port, '0.0.0.0' , ()=>{
    console.log(`Server is running on port ${port}`)

}));




app.get('/health', (req,res) =>{
    res.status(200).json({status: "healthy", timestamp: new Date()});
});
