export const handleErrorMessage = (message: string, data: any, statusCode: number, success: boolean): Promise<any> => {
    return new Promise((resolve, reject) => {
      resolve({
        message,
        data,
        statusCode,
        success
      });
    });
  };

export const generateError = (message : any, status : number) => {
    const validationError : any = new Error(message);
    validationError['data'] = message
    validationError["statusCode"] = status
    return validationError;
};

export const generateValidationError = (messages: any[], status: number) => {
  const errorMessage = messages.map(obj => obj.message).join(', ');
  const validationError: any = new Error(errorMessage);
  validationError["data"] = messages;
  validationError["statusCode"] = status;
  return validationError;
};
