const mongoose = require('mongoose')



const RowErrorSchema = new mongoose.Schema({
    importId: {type: mongoose.Schema.Types.ObjectId, index: true},
    row: {type: Number},
    reason: {type: String},
    raw: {type: mongoose.Schema.Types.Mixed},
}, {timestamps: true});



const RowError = mongoose.model('RowError', RowErrorSchema);

module.exports = RowError