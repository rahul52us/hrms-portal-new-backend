import mongoose, { Schema, Document } from 'mongoose';

export interface IorderPayment extends Document {
    refrenceOrderId : mongoose.Schema.Types.ObjectId,
    order_id?: string;
    payment_id : String;
    signature : String;
    receipt : string;
    user?:string;
    amount?: Number,
    amount_paid? : Number,
    amount_due? : Number,
    currency?:String;
    status?:string;
    payment_details?:any;
    offer_id?:string;
    created_at: Date;
    updated_at: Date;
}

const orderPaymentSchema: Schema = new mongoose.Schema(
    {
        refrenceOrderId : {
            type : mongoose.Schema.Types.ObjectId,
            ref : 'Order'
        },
        order_type : {
            type : String
        },
        payment_id : {
            type : String,
            default : null
        },
        signature : {
          type : String,
          default : null
        },
        order_id : {
            type : String
        },
        amount : {
            type : Number,
            default : 0
        },
        amount_due : {
            type : Number,
            default : 0
        },
        amount_paid : {
            type : Number
        },
        currency : {
            type : String,
            default : 'INR'
        },
        receipt : {
            type : String
        },
        status : {
            type : String,
            default : 'Pending'
        },
        offer_id : {
            type : String,
            default : null
        },
        payment_details: {
            type: {
                method: {
                    type: String
                },
                details: {
                    type: Schema.Types.Mixed
                },
            },
            default : {}
        },
        created_at: {
            type: Date,
            default: Date.now,
        },
        updated_at: {
            type: Date
        }
    }
);

export default mongoose.model<IorderPayment>('orderPayment', orderPaymentSchema);
