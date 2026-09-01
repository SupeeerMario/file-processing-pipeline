require('dotenv').config();
const awsSdk_Client = require('@aws-sdk/client-s3');
const awsSdk_Lib = require('@aws-sdk/lib-storage');

const username = process.env.MINIO_ROOT_USER;
const password = process.env.MINIO_ROOT_PASSWORD;

const s3Client = new awsSdk_Client.S3Client({
    region: 'us-east-1',
    endpoint: 'http://minio:9000',
    credentials: {accessKeyId: username, secretAccessKey: password},
    forcePathStyle: true
});


const BucketName = 'coolbucketname';

const command = new awsSdk_Client.CreateBucketCommand({
    Bucket: BucketName
});

async function ensureBucket(){

    try{
     
        await s3Client.send(command)
        console.log(`Bucket ${BucketName} created`)

    }catch(err){

        if(err.name === 'BucketAlreadyOwnedByYou'){
            console.log(`Bucket with the name of ${BucketName} already exists and owned by you`);

        }else{
            throw err

        }
    }
};

function put(key, stream){

    const uploader = new awsSdk_Lib.Upload({
        client: s3Client,
        params: {Bucket: BucketName, Key: key, Body: stream}
    });

    const upload = uploader.done();
    return ({upload: upload, abort: ()=>{uploader.abort()}})
}

async function get(key){
    
    const command = new awsSdk_Client.GetObjectCommand({
        Bucket: BucketName, Key: key
    });
    
    const res = await s3Client.send(command);
    return res.Body;

}



module.exports = {ensureBucket, put, get}