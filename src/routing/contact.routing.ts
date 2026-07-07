import express from 'express'
import { createContactService, getContactsService, sendResume } from "../services/contact/contact.service";
import authenticate from "../modules/config/authenticate";

const contactRouting = express.Router()
contactRouting.post('/create',createContactService)
contactRouting.get(`/get`,authenticate,getContactsService)
contactRouting.post('/send-resume',sendResume)
export default contactRouting;