const { Client } = require('@notionhq/client');

const notion = new Client({
    auth: process.env.NOTION_INTEGRATION_TOKEN
});

async function getBlockContent(blockUrl) {
    try {
        // 从 URL 提取 block ID
        const blockId = blockUrl.split('#').pop().split('?')[0];
        
        // 获取块内容
        const response = await notion.blocks.retrieve({
            block_id: blockId
        });

        console.log('Block 类型:', response.type);
        
        // 根据块类型获取具体内容
        switch(response.type) {
            case 'paragraph':
                const text = response.paragraph.rich_text
                    .map(t => t.text.content)
                    .join('');
                console.log('内容:', text);
                break;
            case 'heading_1':
            case 'heading_2':
            case 'heading_3':
                const heading = response[response.type].rich_text
                    .map(t => t.text.content)
                    .join('');
                console.log('标题内容:', heading);
                break;
            default:
                console.log('原始响应:', JSON.stringify(response, null, 2));
        }

        // 获取子块
        const children = await notion.blocks.children.list({
            block_id: blockId
        });

        console.log('\n子块数量:', children.results.length);
        
        return response;
    } catch (error) {
        console.error('获取块内容失败:', error.message);
        throw error;
    }
}

// 使用示例
(async () => {
    try {
        const blockUrl = "https://www.notion.so/1bd430fca14481d9a40be9003596205c?pvs=4#1bd430fca1448102b7d2ff1e5df384dc";
        if (!blockUrl) {
            throw new Error('请提供 Notion block URL');
        }
        await getBlockContent(blockUrl);
    } catch (error) {
        console.error('程序执行失败:', error.message);
        process.exit(1);
    }
})();