const mongoose = require('mongoose')



const ContentSchema = new mongoose.Schema({
    importId: {type: mongoose.Schema.Types.ObjectId},
    row: {type: Number},
    name: {type: String},
    email: {type: String},
    country: {type: String},
}, {timestamps: true});

ContentSchema.index({importId: 1, row: 1},{unique: true})

const Content = mongoose.model('Content', ContentSchema);

module.exports = Content