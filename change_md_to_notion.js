const fs = require('fs');
const { Client } = require('@notionhq/client');
const { markdownToBlocks } = require('@tryfabric/martian');

// 从环境变量中读取 Notion Integration Token
const notionToken = process.env.NOTION_INTEGRATION_TOKEN;
if (!notionToken) {
    console.error('请在环境变量中设置 NOTION_INTEGRATION_TOKEN');
    process.exit(1);
}

// 初始化 Notion 客户端
const notion = new Client({ auth: notionToken });

// 将块数组分成多个批次，每批不超过100个块
function chunkBlocks(blocks, size = 100) {
    const chunks = [];
    for (let i = 0; i < blocks.length; i += size) {
        chunks.push(blocks.slice(i, i + size));
    }
    return chunks;
}

// 新增: 从References部分提取URL映射
function extractReferencesUrls(mdContent) {
    const urlMap = new Map();
    const referenceSection = mdContent.match(/## References\n([\s\S]*?)(?=\n##|$)/);

    if (referenceSection) {
        const references = referenceSection[1].trim().split('\n');
        for (const ref of references) {
            const match = ref.match(/^\[(\d+)\].*?(https?:\/\/[^\s]+)/);
            if (match) {
                urlMap.set(match[1], match[2].trim());
            }
        }
    }
    return urlMap;
}

// 添加一个新的辅助函数来拆分富文本数组
function splitRichTextArray(richTextArray, maxLength = 100) {
    if (richTextArray.length <= maxLength) {
        return [richTextArray];
    }
    
    const chunks = [];
    for (let i = 0; i < richTextArray.length; i += maxLength) {
        chunks.push(richTextArray.slice(i, i + maxLength));
    }
    return chunks;
}

// 将 Markdown 文件加载到 Notion 页面
async function uploadMarkdownToNotion(mdFilePath, parentPageId) {
    try {
        // 读取 Markdown 文件内容
        const mdContent = fs.readFileSync(mdFilePath, 'utf-8');
        
        // 先提取引用URL映射
        const referenceMap = extractReferencesUrls(mdContent);
        
        // 使用 martian 将 Markdown 转换为 Notion 块
        let blocks = await markdownToBlocks(mdContent);

        // 处理引用链接
        blocks = blocks.map(block => {
            if (block.type === 'paragraph' && block.paragraph.rich_text.length > 0) {
                const text = block.paragraph.rich_text[0].text.content;
                const citationPattern = /\[(\d+(?:\s*,\s*\d+)*?)(?=\])\]/g;
                
                if (text.match(citationPattern)) {
                    const newRichText = [];
                    let lastIndex = 0;
                    let match;

                    while ((match = citationPattern.exec(text)) !== null) {
                        // 添加引用前的文本
                        if (match.index > lastIndex) {
                            newRichText.push({
                                type: 'text',
                                text: { content: text.slice(lastIndex, match.index) }
                            });
                        }

                        // 处理引用
                        const refNumbers = match[1].split(',').map(num => num.trim());
                        for (let i = 0; i < refNumbers.length; i++) {
                            const refNumber = refNumbers[i];
                            const targetUrl = referenceMap.get(refNumber);

                            if (i > 0) {
                                newRichText.push({
                                    type: 'text',
                                    text: { content: ', ' }
                                });
                            } else {
                                newRichText.push({
                                    type: 'text',
                                    text: { content: '[' }
                                });
                            }

                            newRichText.push({
                                type: 'text',
                                text: {
                                    content: refNumber,
                                    link: targetUrl ? { url: targetUrl } : null
                                }
                            });

                            if (i === refNumbers.length - 1) {
                                newRichText.push({
                                    type: 'text',
                                    text: { content: ']' }
                                });
                            }
                        }

                        lastIndex = match.index + match[0].length;
                    }

                    // 添加剩余文本
                    if (lastIndex < text.length) {
                        newRichText.push({
                            type: 'text',
                            text: { content: text.slice(lastIndex) }
                        });
                    }

                    block.paragraph.rich_text = newRichText;
                }
            }
            return block;
        });

        // 处理富文本数组长度限制
        blocks = blocks.map(block => {
            if (block.type === 'paragraph' && 
                block.paragraph.rich_text && 
                block.paragraph.rich_text.length > 100) {
                
                // 拆分富文本数组
                const textChunks = splitRichTextArray(block.paragraph.rich_text);
                
                // 创建多个段落块
                return textChunks.map(chunk => ({
                    type: 'paragraph',
                    paragraph: {
                        rich_text: chunk
                    }
                }));
            }
            return [block];
        }).flat();

        // 添加目录等
        blocks = [
            { object: 'block', type: 'divider', divider: {} },
            { object: 'block', type: 'table_of_contents', table_of_contents: {} },
            { object: 'block', type: 'divider', divider: {} },
            ...blocks
        ];

        // 创建 Notion 页面
        const page = await notion.pages.create({
            parent: { page_id: parentPageId },
            properties: {
                title: {
                    title: [
                        {
                            text: {
                                content: mdFilePath.split('/').pop().replace('.md', ''),
                            },
                        },
                    ],
                },
            },
        });

        // 分批上传块
        console.log('开始上传内容...');
        const blockChunks = chunkBlocks(blocks);
        for (let i = 0; i < blockChunks.length; i++) {
            await notion.blocks.children.append({
                block_id: page.id,
                children: blockChunks[i]
            });
            const progress = Math.round(((i + 1) / blockChunks.length) * 100);
            process.stdout.write(`\r正在上传... ${progress}% [${i + 1}/${blockChunks.length}]`);
        }

        console.log('\n上传完成');
        console.log('Notion 页面创建成功:', page.url);
        return page.url;
    } catch (error) {
        console.error('上传 Markdown 到 Notion 时出错:', error.message);
        if (error.code === 'validation_error') {
            console.log('详细错误信息:', JSON.stringify(error.body, null, 2));
        }
        throw error;
    }
}

// 检查文件是否需要处理
async function checkNeedsProcessing(mdFilePath) {
    const metadataPath = './files/metadata.json';
    let metadata;
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch (error) {
        metadata = { documents: [] };
    }

    const fileName = mdFilePath.split('/').pop();
    const existingDoc = metadata.documents.find(doc => doc.file === fileName);
    
    return !existingDoc || !existingDoc.notion_url;
}

// 添加或更新 metadata
async function addToMetadata(mdFilePath, notionUrl) {
    const metadataPath = './files/metadata.json';
    let metadata;
    try {
        metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
    } catch (error) {
        metadata = { documents: [] };
    }

    const fileName = mdFilePath.split('/').pop();
    const existingDoc = metadata.documents.find(doc => doc.file === fileName);
    
    if (!existingDoc) {
        // 添加新文档
        metadata.documents.push({
            title: fileName.replace('.md', ''),
            file: notionUrl,
            date: new Date().toISOString().split('T')[0]
        });
    } else {
        // 更新现有文档
        existingDoc.notion_url = notionUrl;
        existingDoc.date = new Date().toISOString().split('T')[0];
    }
    
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
}

// 修改 processAllMarkdownFiles 函数中的相关部分
async function processAllMarkdownFiles() {
    try {
        const files = fs.readdirSync('./files')
            .filter(file => file.endsWith('.md'));
        
        console.log(`找到 ${files.length} 个 Markdown 文件`);
        
        const results = [];
        // 串行处理每个文件
        for (const file of files) {
            const filePath = `./files/${file}`;
            const needsProcessing = await checkNeedsProcessing(filePath);
            
            if (needsProcessing) {
                console.log(`\n开始处理: ${file}`);
                const parentPageId = '1bc430fca1448058b3d1fba86dfc27cf';
                try {
                    const notionPageUrl = await uploadMarkdownToNotion(filePath, parentPageId);
                    await addToMetadata(filePath, notionPageUrl);
                    console.log(`✅ 文件 ${file} 处理完成，URL: ${notionPageUrl}`);
                    results.push({ file, success: true, url: notionPageUrl });
                    
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } catch (error) {
                    console.error(`❌ 文件 ${file} 处理失败:`, error.message);
                    results.push({ file, success: false, error: error.message });
                }
            } else {
                console.log(`⏭️  跳过已处理的文件: ${file}`);
                results.push({ file, success: true, skipped: true });
            }
        }

        // 统计处理结果
        const stats = {
            total: results.length,
            processed: results.filter(r => r.success && !r.skipped).length,
            skipped: results.filter(r => r.skipped).length,
            failed: results.filter(r => !r.success).length
        };

        console.log('\n处理统计:');
        console.log(`总文件数: ${stats.total}`);
        console.log(`成功处理: ${stats.processed}`);
        console.log(`已跳过: ${stats.skipped}`);
        console.log(`处理失败: ${stats.failed}`);
        
        if (stats.failed > 0) {
            console.log('\n失败的文件:');
            results
                .filter(r => !r.success)
                .forEach(r => console.log(`- ${r.file}: ${r.error}`));
        }

    } catch (error) {
        console.error('处理文件时出错:', error.message);
        process.exit(1);
    }
}

// 修改主调用函数
(async () => {
    try {
        await processAllMarkdownFiles();
    } catch (error) {
        console.error('程序执行失败:', error.message);
        process.exit(1);
    }
})();