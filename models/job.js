const mongoose = require('mongoose')

const STATUS_OPTION = ['pending', 'processing', 'dead_lettered', 'failed', 'done'];

const FROM_TRANSITIONS = {
    done: ['processing'],
    failed: ['processing'],
    dead_lettered: ['processing'],
    processing: ['pending'],
}

const JobSchema = new mongoose.Schema({
    filename: {type: String, required: true},
    storageKey: {type: String, required: true},
    status: {type: String, enum: STATUS_OPTION, default: 'pending'},
    totalRows: {type: Number, default: 0},
    rowsOk: {type: Number, default: 0},
    rowsFailed: {type: Number, default: 0},
    lastCommittedChunk: {type: Number, default: 0},
    attempts: {type: Number, default: 0},
    error: {type: String},
}, {timestamps: true});


JobSchema.statics.transition = async function (jobId, nextStatus) {

    if (!STATUS_OPTION.includes(nextStatus)){
        throw new Error('invalid status option');
    }

    const updated_job = await this.updateOne(
        {_id: jobId, status: {$in: FROM_TRANSITIONS[nextStatus]}},
        {$set: {status: nextStatus}});

    const count = updated_job.matchedCount;

    return count;

};


const Job = mongoose.model('Job', JobSchema);

module.exports = Job