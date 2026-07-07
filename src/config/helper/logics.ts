import { uploadFile } from "../../repository/uploadDoc.repository";

export async function processCategories(req : any , categories: any[], savedData : any) {
    let cate: any = [];
    if (Array.isArray(categories)) {
      for (const item of categories) {
        if (item.thumbnail !== "" && item.thumbnail) {
          try {
            const url = await uploadFile(item.thumbnail);
            const fileData: any = {
              name: item.thumbnail.filename,
              url: url,
              type: item.thumbnail.type,
            };
            cate.push({
              ...item,
              company: req.bodyData.company,
              createdBy: req.userId,
              quiz: savedData._id,
              thumbnail: fileData,
            });
          } catch (error) {
            cate.push({
              ...item,
              company: req.bodyData.company,
              createdBy: req.userId,
              quiz: savedData._id,
            });
          }
        } else {
          cate.push({
            ...item,
            company: req.bodyData.company,
            createdBy: req.userId,
            quiz: savedData._id,
          });
        }
      }
    }

    return cate;
  }
