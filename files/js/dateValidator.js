// 日期验证和格式化工具

function validateAndFormatDate(dateStr) {
    // 支持的日期格式: YYYY-M-D, YYYY-MM-DD
    const dateRegex = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
    const match = dateStr.match(dateRegex);
    
    if (!match) {
        return null;
    }
    
    const year = parseInt(match[1]);
    const month = parseInt(match[2]);
    const day = parseInt(match[3]);
    
    // 验证月份和日期的有效性
    if (month < 1 || month > 12) {
        return null;
    }
    
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day < 1 || day > daysInMonth) {
        return null;
    }
    
    // 格式化日期为YYYY-MM-DD
    const formattedMonth = month.toString().padStart(2, '0');
    const formattedDay = day.toString().padStart(2, '0');
    
    return `${year}-${formattedMonth}-${formattedDay}`;
}

function validateMetadataDate(metadata) {
    if (!metadata || !metadata.documents) {
        return false;
    }
    
    let hasChanges = false;
    
    metadata.documents.forEach(doc => {
        if (doc.date) {
            const formattedDate = validateAndFormatDate(doc.date);
            if (formattedDate && doc.date !== formattedDate) {
                doc.date = formattedDate;
                hasChanges = true;
            }
        }
    });
    
    return hasChanges;
}

// 导出函数供其他模块使用
module.exports = {
    validateAndFormatDate,
    validateMetadataDate
};