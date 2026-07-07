import authenticate from "../modules/config/authenticate";
import { createTestimonail, deleteTestimonial, getTestimonials, updateTestimonial } from "../modules/Testimonial/Testimonial";
import express from 'express'

const router = express.Router()
router.post('/create',authenticate,createTestimonail)
router.put('/:id',authenticate,updateTestimonial)
router.get(`/get`,getTestimonials)
router.delete('/:id',authenticate,deleteTestimonial)
export default router;