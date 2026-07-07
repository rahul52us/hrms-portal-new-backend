import { getNotification, markNotificationAsRead } from "../../services/notification/notification.service";
import {
  listCompanyNotificationUsers,
  sendCompanyNotification,
} from "../../services/notification/emailNotification.service";
import authenticate from "../../modules/config/authenticate";
import express from 'express'

const router = express.Router()
router.get('/',authenticate,getNotification)
router.get('/users',authenticate,listCompanyNotificationUsers)
router.post('/send',authenticate,sendCompanyNotification)
router.put('/',authenticate,markNotificationAsRead)
export default router;
