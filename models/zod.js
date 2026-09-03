const { z } = require('zod');

const contentSchema = z.object({
    customer_id: z.string().min(1),
    name: z.string().min(1),
    email: z.email(),
    country: z.string(),
})




module.exports = contentSchema
