require('dotenv').config();

const express = require('express');
const connectDB = require('./connectDB');
const storage = require('./storage');
const app = express();
const port = process.env.SERVER_PORT;
const busboy = require('busboy');
const mongoose = require('mongoose');
const Job = require('./models/job');
const { publish } = require('./queue');

connectDB().then(storage.ensureBucket).catch(err =>{
    console.log('error while creating bucket', err);
    process.exit(1);
}).then(()=> app.listen(port, '0.0.0.0' , ()=>{
    console.log(`Server is running on port ${port}`)

}));






app.get('/health', (req,res) =>{
    res.status(200).json({status: "healthy", timestamp: new Date()});
});


async function receiveUpload(req,jobId){
    
    return new Promise((resolve, reject) =>{
        const bb = busboy({ headers: req.headers});
        let uploading = null;
        let originalName = '';
        let key = '';
        bb.on('file', (name, file, info)=>{
            const { filename, encoding, mimeType} = info;
            
            const file_ext = info.filename.split('.').pop().toLowerCase();
            const allowed_ext = ['csv', 'xlsx']
            if(!allowed_ext.includes(file_ext)){
                file.resume()
                reject(new Error('Wrong file format'))
                return
            }

            key = `upload/${jobId}.${file_ext}`


            originalName = filename;

            console.log(
              `File [${name}]: filename: ${filename}, encoding: ${encoding}, mimeType: ${mimeType}`
            );

            uploading = storage.put(key, file);

            file.on('error', (error)=>{
                reject(new Error(`File upload stream error : ${error.message}`));
            });
        });

        bb.on('close', ()=>{
            if(uploading !== null){
                uploading.then(() => resolve({filename: originalName, key: key}), reject)
            }else{
                reject(new Error("No file provided"));
            }
        });
        
        bb.on('error', (error)=>{
            
            reject(new Error(`Busboy parsing error: ${error.message}`));
        });

    req.pipe(bb);    
    });
}

app.post('/upload', async (req,res)=>{
    const jobId = new mongoose.Types.ObjectId();

    const {filename, key} = await receiveUpload(req, jobId);


    await Job.create({_id: jobId, filename: filename, storageKey: key})
    await publish(jobId)

    res.status(202).json({jobId});
});