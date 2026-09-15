const mongoose = require('mongoose')



const RowErrorSchema = new mongoose.Schema({
    importId: { type: mongoose.Schema.Types.ObjectId },
    row: { type: Number },
    reason: { type: String },
    raw: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });


RowErrorSchema.index({ importId: 1, row: 1 }, { unique: true })

const RowError = mongoose.model('RowError', RowErrorSchema);

module.exports = RowError