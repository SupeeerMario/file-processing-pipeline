require('dotenv').config();

const express = require('express');
const connectDB = require('./connectDB');
const app = express();
const port = process.env.SERVER_PORT;


connectDB().then(()=> app.listen(port, '0.0.0.0' , ()=>{
    console.log(`Server is running on port ${port}`)

}));

