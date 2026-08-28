require('dotenv').config();
const awsSdk = require('@aws-sdk/client-s3')

const username = process.env.MINIO_ROOT_USER;
const password = process.env.MINIO_ROOT_PASSWORD;

const s3Client = new awsSdk.S3Client({
    region: 'us-east-1',
    endpoint: 'http://minio:9000',
    credentials: {accessKeyId: username, secretAccessKey: password},
    forcePathStyle: true
});


const BucketName = 'coolbucketname';

const command = new awsSdk.CreateBucketCommand({
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

module.exports = ensureBucket