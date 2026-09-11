const { z } = require('zod');

const contentSchema = z.object({
    name: z.string().min(1),
    email: z.email(),
    country: z.string(),
})




module.exports = contentSchema
