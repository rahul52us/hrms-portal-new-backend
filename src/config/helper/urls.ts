let baseURL : any = undefined
let baseDashURL : any = undefined

import dotenv from'dotenv'

dotenv.config()

if(process.env.NODE_ENV === "production"){
    baseURL = process.env.FRONTEND_BASE_PROD_URL
    baseDashURL = `${process.env.FRONTEND_BASE_PROD_URL}/dashboard`
}
else {
    baseURL = process.env.FRONTEND_BASE_DEV_URL
    baseDashURL = `${process.env.FRONTEND_BASE_DEV_URL}/dashboard`
}

export {baseURL,baseDashURL}