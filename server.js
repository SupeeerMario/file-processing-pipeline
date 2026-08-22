require('dotenv').config();

const express = require('express');
const app = express();
const port = process.env.Server_Port;


app.listen(port, ()=>{
    console.log(`Server is running on port ${port}`)
});