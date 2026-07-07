import { NextFunction } from "express"
import Token from "../../schemas/Token/Token"

export const createToken = async (data : any) => {
    try
    {
        const tkon = new Token({...data, is_active : true})
        const savedToken = await tkon.save()
        return {
            status : 'success',
            data : savedToken
        }
    }
    catch(err : any)
    {
        return {
            status : 'error',
            data : err?.message
        }
    }
}

export const findToken = async(data : any) => {
    try
    {
        const tkon = await Token.findOne({token : data.token , is_active : true, ...data})
        if(tkon){
            return {
                status : 'success',
                data : tkon
            }
        }
        else {
            return {
                status : 'error',
                data : 'Token does not exists'
            }
        }
    }
    catch(err : any)
    {
        return {
            status : 'error',
            data : err?.message
        }
    }
}

export const verifyToken = async (data : any) => {
    try
    {
        const tkon = await Token.findOne({company : data.company , userId : data.userId, token : data.token, type : data.type})
        if(tkon){
            tkon.deletedAt = new Date()
            await tkon.save()
            return ({
                message : 'Token has been verified',
                data : tkon,
                status : 'success',
                statusCode : 200
            })
        }
        else
        {
             return({
                message : 'Invalid token',
                data : null,
                status : 'error',
                statusCode : 300

            })
        }
    }
    catch(err)
    {
        return({
            message : 'Invalid token',
            data : null,
            status : 'error',
            statusCode : 500
        })}
}
