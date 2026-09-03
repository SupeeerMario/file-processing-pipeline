const mongoose = require('mongoose')



const ContentSchema = new mongoose.Schema({
    customer_id: {type: String, unique: true},
    name: {type: String},
    email: {type: String},
    country: {type: String},
}, {timestamps: true});



const Content = mongoose.model('Content', ContentSchema);

module.exports = Content