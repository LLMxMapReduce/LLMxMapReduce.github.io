require('dotenv').config();
const fs = require('fs');
const { Client } = require('@larksuiteoapi/node-sdk');
const { exec } = require('child_process');

// 初始化飞书客户端
const client = new Client({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    disableTokenCache: false,
});

const wiki_space_id = process.env.FEISHU_WIKI_SPACE_ID;
const domain_name = process.env.FEISHU_DOMAIN_NAME;

// 添加缓存节点列表
let cachedNodes = null;

// 获取所有节点的函数
async function getAllNodes(rootToken) {
    if (cachedNodes) {
        return cachedNodes;
    }
    try {
        let hasMore = true;
        let pageToken = '';
        const pageSize = 50;
        const allNodes = [];

        console.log('开始获取所有节点...');
        while (hasMore) {
            const response = await client.wiki.v2.spaceNode.list({
                path: {
                    space_id: wiki_space_id,
                },
                params: {
                    page_size: pageSize,
                    page_token: pageToken,
                    parent_node_token: rootToken,
                },
            });

            if (!response.data.items || response.data.items.length === 0) {
                break;
            }
            allNodes.push(...response.data.items);
            console.log(`已获取 ${allNodes.length} 个节点...`);

            pageToken = response.data.page_token;
            hasMore = response.data.has_more;

            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }

        console.log(`节点获取完成，共 ${allNodes.length} 个节点`);
        return allNodes;
    } catch (error) {
        console.error('获取节点列表失败:', error.message);
        throw error;
    }
}

// 添加 block 类型映射
const BLOCK_TYPE_MAP = {
    'page': 1,
    'text': 2,
    'heading1': 3,
    'heading2': 4,
    'heading3': 5,
    'heading4': 6,
    'heading5': 7,
    'heading6': 8,
    'heading7': 9,
    'heading8': 10,
    'heading9': 11,
    'bullet': 12,
    'ordered': 13,
    'code': 14,
    'quote': 15,
    'todo': 17,
    'callout': 19,
    'divider': 22,
    'image': 27,
    'table': 31,
    'table_cell': 32,
};

// 辅助函数：渲染 mermaid 代码并上传图片（这里以模拟方式返回图片 URL）
async function renderMermaidAndUpload(figureTitle, codeContent, childObjToken) {
    const os = require('os');
    const tmpDir = os.tmpdir();
    const path = require('path');
    const fs = require('fs');
    const { execSync } = require('child_process');

    const fileName = (figureTitle.trim() || 'figure') + '.png';
    const tmpFile = path.join(tmpDir, figureTitle.trim() + '.mmd');
    const outputFilePath = path.join(tmpDir, fileName);

    const procContent = codeContent.replace(/\\n/g, '\n');
    fs.writeFileSync(tmpFile, procContent, 'utf-8');
    try {
        // 使用 npx 调用 mmdc 渲染 mermaid 代码
        execSync(`npx mmdc -i "${tmpFile}" -o "${outputFilePath}"`);
        console.log(`Mermaid 渲染成功: ${fileName}`);
    } catch (error) {
        console.error(`Mermaid 渲染失败, 跳过当前图片`);
        return;
    }

    const block = [
        {
            block_type: BLOCK_TYPE_MAP.image,
            image: {}
        }
    ];
    const pic_upload_result = await uploadBlocks(block, childObjToken);
    const pic_block_id = pic_upload_result.data.children[0].block_id;

    // 获取图片的二进制内容和文件大小
    const fileStream = fs.createReadStream(outputFilePath);
    const fileStats = fs.statSync(outputFilePath);
    const fileSize = fileStats.size;

    const result = await client.drive.v1.media.uploadAll({
        data: {
            file_name: fileName,
            parent_type: 'docx_image',
            parent_node: pic_block_id,
            size: fileSize,
            file: fileStream,
        },
    });

    const imageFileToken = result.file_token;

    const update_result = await client.docx.v1.documentBlock.batchUpdate({
        path: {
            document_id: childObjToken,
        },
        data: {
            requests: [
                {
                    block_id: pic_block_id,
                    replace_image: {
                        token: imageFileToken
                    }
                }
            ]
        }
    });

    fs.unlinkSync(tmpFile);
    fs.unlinkSync(outputFilePath);
    return result;
}

// 辅助函数：解析 markdown 表格内容，将其转换成二维数组（行和列）
function parseMarkdownTable(tableContent) {
    // 拆分全部行并过滤空行
    const content = tableContent.trim().replace(/\\n/g, '\n');
    const lines = content.split('\n').filter(line => line.trim());
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
        // 移除行首和行尾的竖线，并按竖线分割，再去除每个单元格的空格
        const cells = lines[i].replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
        // 如果这一行是分隔行（只包含 - 和 :），则跳过
        if (i === 1 && cells.every(cell => /^[:\-]+$/.test(cell))) {
            continue;
        }
        rows.push(cells);
    }
    return rows;
}

async function updateFeishuTableContent(tableData, childObjToken) {
    // 计算表格维度：行数 m 和列数 n（取所有行中最大列数）
    const m = tableData.length;
    const n = Math.max(...tableData.map(row => row.length));

    // 生成一个唯一的表格块 id（可根据需求调整生成规则）
    const tableBlockId = `table_${Date.now()}`;
    const cellIds = [];  // 用于记录所有单元格 block_id，按行优先顺序排列

    // 构造 descendants 数组，用于一次性创建整个表格块及其内部单元格和文本块
    const descendants = [];

    // 添加表格块，类型为 BLOCK_TYPE_MAP.table (31)
    descendants.push({
        block_id: tableBlockId,
        children: [], // 后续再添加各单元格的 id
        block_type: BLOCK_TYPE_MAP.table,
        table: {
            property: {
                row_size: m,
                column_size: n
            }
        }
    });

    // 对于每个单元格，创建 table_cell 块和对应的文本块
    for (let i = 0; i < m; i++) {
        for (let j = 0; j < n; j++) {
            const cellId = `table_cell_${i}_${j}`;
            cellIds.push(cellId);
            const textBlockId = `table_cell_${i}_${j}_text`;
            descendants.push({
                block_id: cellId,
                children: [textBlockId],
                block_type: BLOCK_TYPE_MAP.table_cell,
                table_cell: {}
            });

            const cellContent = tableData[i][j] || "";
            descendants.push({
                block_id: textBlockId,
                children: [],
                block_type: BLOCK_TYPE_MAP.text,
                text: {
                    elements: {
                        text_run: {
                            content: cellContent,
                        }
                    }
                }
            });
        }
    }

    // 更新表格块的 children 字段为所有单元格 id（按从左到右、从上到下排列）
    descendants[0].children = cellIds;

    // 构造 payload，参照示例接口，注意：children_id 数组需包含表格块的 id
    const payload = {
        path: {
            document_id: childObjToken,
            block_id: childObjToken
        },
        data: {
            // 这里将表格块 id 放到 children_id 中，表示该块为此次创建的目标
            children_id: [tableBlockId],
            descendants: descendants
        }
    };

    // 调用 Feishu API 创建 Descendant 块，即创建整个表格及其内部内容
    try {
        const result = await client.docx.v1.documentBlockDescendant.create(payload);
        console.log("表格上传成功");
        return;
    } catch (error) {
        console.error("表格上传失败:", error.message);
        return;
    }

}

// 处理行内格式（加粗、斜体、链接等）
function processInlineFormatting(text) {
    const parts = [];
    let currentText = '';
    let i = 0;

    while (i < text.length) {
        if (text.slice(i).match(/^\$\$([^$]+)\$\$/)) {
            const match = text.slice(i).match(/^\$\$([^$]+)\$\$/);
            if (currentText) {
                parts.push({
                    text_run: {
                        content: currentText
                    }
                });
                currentText = '';
            }
            parts.push({
                equation: {
                    content: match[1].trim(),
                }
            });
            i += match[0].length;
            continue;
        }

        // 处理行内公式 ($...$)
        if (text.slice(i).match(/^\$([^$]+)\$/)) {
            const match = text.slice(i).match(/^\$([^$]+)\$/);
            if (currentText) {
                parts.push({
                    text_run: {
                        content: currentText
                    }
                });
                currentText = '';
            }
            parts.push({
                equation: {
                    content: match[1].trim(),
                }
            });
            i += match[0].length;
            continue;
        }
        // 处理加粗
        if (text.slice(i).match(/^\*\*([^*]+)\*\*/)) {
            const match = text.slice(i).match(/^\*\*([^*]+)\*\*/);
            if (currentText) {
                parts.push({
                    text_run: {
                        content: currentText
                    }
                });
                currentText = '';
            }
            parts.push({
                text_run: {
                    content: match[1],
                    text_element_style: {
                        bold: true
                    }
                }

            });
            i += match[0].length;
            continue;
        }

        // 处理斜体
        if (text.slice(i).match(/^\*([^*]+)\*/)) {
            const match = text.slice(i).match(/^\*([^*]+)\*/);
            if (currentText) {
                parts.push({
                    text_run: {
                        content: currentText
                    }
                });
                currentText = '';
            }
            parts.push({
                text_run: {
                    content: match[1],
                    text_element_style: {
                        italic: true
                    }
                }
            });
            i += match[0].length;
            continue;
        }

        // 处理链接
        if (text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/)) {
            const match = text.slice(i).match(/^\[([^\]]+)\]\(([^)]+)\)/);
            if (currentText) {
                parts.push({
                    text_run: {
                        content: currentText
                    }
                });
                currentText = '';
            }
            parts.push({
                text_run: {
                    content: match[1],
                    link: {
                        url: encodeURIComponent(match[2])
                    }
                }
            });
            i += match[0].length;
            continue;
        }

        currentText += text[i];
        i++;
    }

    if (currentText) {
        parts.push({
            text_run: {
                content: currentText
            }
        });
    }

    return parts;
}

// 添加分块函数
function chunkBlocks(blocks, size = 50) {
    const chunks = [];
    for (let i = 0; i < blocks.length; i += size) {
        chunks.push(blocks.slice(i, i + size));
    }
    return chunks;
}

async function uploadBlocks(chunk, childObjToken) {
    const result = await client.docx.v1.documentBlockChildren.create({
        path: {
            document_id: childObjToken,
            block_id: childObjToken
        },
        data: {
            children: chunk,
        }
    });
    return result;
}

async function uploadMultiChunks(accumulatedBlocks, childObjToken) {
    let results = [];
    if (accumulatedBlocks.length > 0) {
        const chunks = chunkBlocks(accumulatedBlocks, 50);
        for (const chunk of chunks) {
            const result = await uploadBlocks(chunk, childObjToken);
            results.push(result);
        }
        accumulatedBlocks = [];
    }
    // 同样返回对象
    return results;
}

// 添加预处理函数在 processAndUploadMdContent 函数之前
function preprocessMarkdown(mdContent) {
    // 使用正则表达式匹配多行LaTeX公式
    const multiLineLatexRegex = /\$\$([\s\S]*?)\$\$/g;

    // 替换多行公式为单行
    let processedContent = mdContent.replace(multiLineLatexRegex, (match, formula) => {
        // 去除公式内的换行和多余空格
        let processedFormula = formula
            .trim()
            .replace(/\n\s*/g, ' ')
            .replace(/\s+/g, ' ');
        return `$$${processedFormula}$$`;
    });

    return processedContent;
}

// 修改 processAndUploadMdContent 函数,在开始处添加预处理步骤
async function processAndUploadMdContent(mdContent, childObjToken) {
    // 添加预处理步骤
    const processedContent = preprocessMarkdown(mdContent);

    let accumulatedBlocks = [];
    const lines = processedContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // 检测 mermaid 块
        const mermaidRegex = /<figure-link\s+title=['"]([^'"]+)['"]\s+type=['"]mermaid['"]\s+content=['"]([\s\S]*?)['"]><\/figure-link>/;
        const mermaidMatch = line.match(mermaidRegex);
        if (mermaidMatch) {
            const result = await uploadMultiChunks(accumulatedBlocks, childObjToken);
            accumulatedBlocks = [];
            const figureTitle = mermaidMatch[1];
            const codeContent = mermaidMatch[2];
            const uploadResult = await renderMermaidAndUpload(figureTitle, codeContent, childObjToken);
            continue;
        }

        // 检测 markdown 表格块
        const tableRegex = /<figure-link\s+title=['"]([^'"]+)['"]\s+type=['"]markdown['"]\s+content=['"]([\s\S]*?)['"]><\/figure-link>/;
        const tableMatch = line.match(tableRegex);
        if (tableMatch) {
            // 先上传前面已经解析的块，使用 chunkBlocks 分块上传
            const result = await uploadMultiChunks(accumulatedBlocks, childObjToken);
            accumulatedBlocks = [];
            // 直接从匹配结果获取表格内容（无需替换 '\\n'）
            const tableContent = tableMatch[2];
            const rows = parseMarkdownTable(tableContent);
            // 调用函数上传表格块（内部会创建表格块并依次填充各单元格）
            await updateFeishuTableContent(rows, childObjToken);
            continue;
        }

        // 处理标题
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            switch (level) {
                case 1:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading1,
                        heading1: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
                case 2:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading2,
                        heading2: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
                case 3:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading3,
                        heading3: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
                case 4:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading4,
                        heading4: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
                case 5:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading5,
                        heading5: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
                case 6:
                    accumulatedBlocks.push({
                        block_type: BLOCK_TYPE_MAP.heading6,
                        heading6: {
                            elements: [{
                                text_run: {
                                    content: headingMatch[2]
                                }
                            }]
                        }
                    });
                    break;
            }
            continue;
        }

        // 处理无序列表
        if (line.match(/^[\-\*]\s+(.+)$/)) {
            const content = line.replace(/^[\-\*]\s+/, '');
            accumulatedBlocks.push({
                block_type: BLOCK_TYPE_MAP.bullet,  // 使用数字类型 12
                bullet: {
                    elements: [{
                        text_run: {
                            content: content
                        }
                    }]
                }
            });
            continue;
        }

        // 处理有序列表
        const orderedListMatch = line.match(/^\d+\.\s+(.+)$/);
        if (orderedListMatch) {
            accumulatedBlocks.push({
                block_type: BLOCK_TYPE_MAP.ordered,  // 使用数字类型 13
                ordered: {
                    elements: [{
                        text_run: {
                            content: orderedListMatch[1]
                        }
                    }]
                }
            });
            continue;
        }

        // 处理分割线
        if (line.match(/^[\-\*_]{3,}$/)) {
            accumulatedBlocks.push({
                block_type: BLOCK_TYPE_MAP.divider,  // 使用数字类型 22
                divider: {}
            });
            continue;
        }

        // 处理普通段落
        if (line.trim()) {
            // 处理行内格式
            const elements = processInlineFormatting(line);
            accumulatedBlocks.push({
                block_type: BLOCK_TYPE_MAP.text,  // 使用数字类型 2
                text: {
                    elements: elements
                }
            });
        }
    }

    const result = await uploadMultiChunks(accumulatedBlocks, childObjToken);
    accumulatedBlocks = [];
}

// 修改上传函数，支持更新现有文档
async function uploadToFeishu(mdContent, fileName) {
    try {
        const rootToken = process.env.FEISHU_ROOT_TOKEN;
        // 1. 查找或创建父节点 A
        cachedNodes = await getAllNodes(rootToken);
        let parentNode = cachedNodes.find(node => node.title === fileName);
        let parentNodeToken;
        let parentObjToken;

        if (!parentNode) {
            console.log(`创建父节点: ${fileName}`);
            const createParentResponse = await client.wiki.v2.spaceNode.create({
                path: { space_id: wiki_space_id },
                data: {
                    obj_type: 'docx',
                    parent_node_token: rootToken,
                    node_type: 'origin',
                    title: fileName,
                }
            });
            parentNodeToken = createParentResponse.data.node.node_token;
            parentObjToken = createParentResponse.data.node.obj_token;
        } else {
            parentNodeToken = parentNode.node_token;
            parentObjToken = parentNode.obj_token;
            console.log(`找到现有父节点: ${fileName}`);
        }

        // 2. 创建内容节点 B
        const currentDate = new Date();
        const childTitle = `${currentDate.toISOString()}_${fileName}`;

        console.log(`创建内容节点: ${childTitle}`);
        const createChildResponse = await client.wiki.v2.spaceNode.create({
            path: { space_id: wiki_space_id },
            data: {
                obj_type: 'docx',
                parent_node_token: parentNodeToken,
                node_type: 'origin',
                title: childTitle,
            }
        });
        const childToken = createChildResponse.data.node.node_token;
        const childObjToken = createChildResponse.data.node.obj_token;

        // 3. 解析 Markdown 并沿解析过程中实时上传块
        await processAndUploadMdContent(mdContent, childObjToken);

        // 4. 获取节点 B 的链接
        const childUrl = `https://${domain_name}.feishu.cn/wiki/${childToken}`;

        // 5. 更新父节点 A 的内容（例如，将新文档的链接添加到父节点）
        const summaryBlocks = [
            {
                block_type: BLOCK_TYPE_MAP.text,
                text: {
                    elements: [
                        {
                            text_run: {
                                content: childTitle,
                                text_element_style: {
                                    link: {
                                        url: childUrl
                                    }
                                }
                            }
                        }
                    ]
                }
            }
        ];

        await client.docx.v1.documentBlockChildren.create({
            path: {
                document_id: parentObjToken,
                block_id: parentObjToken
            },
            data: {
                children: summaryBlocks,
                // index: 0
            }
        });

        console.log('\n✅ 文档创建成功');
        console.log(`📝 父节点链接: https://${domain_name}.feishu.cn/wiki/${parentNodeToken}`);
        console.log(`📄 内容节点链接: ${childUrl}`);

        return {
            parentUrl: `https://${domain_name}.feishu.cn/wiki/${parentNodeToken}`,
            contentUrl: childUrl,
            createTime: currentDate.toISOString()
        };

    } catch (error) {
        console.error('处理文档时出错:', error.message);
        throw error;
    }
}

async function getLikesByNode(node) {
    let allLikes = [];
    let hasMore = true;
    let pageToken = '';
    const pageSize = 50;

    while (hasMore) {
        try {
            const likeResponse = await client.drive.v2.fileLike.list({
                path: {
                    file_token: node.obj_token
                },
                params: {
                    file_type: node.obj_type,
                    page_size: pageSize,
                    page_token: pageToken
                }
            });

            if (!likeResponse.data.items || likeResponse.data.items.length === 0) {
                break;
            }

            allLikes.push(...likeResponse.data.items);

            pageToken = likeResponse.data.page_token;
            hasMore = likeResponse.data.has_more;

            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (error) {
            console.warn(`获取节点 ${node.title} 的点赞信息失败:`, error.message);
            break;
        }
    }

    return allLikes.length;
}

// 添加获取节点 URL 的辅助函数
function getNodeUrl(node) {
    return `https://${domain_name}.feishu.cn/wiki/${node.node_token}`;
}

// 修改 getAllLikes 函数中获取点赞的部分
async function getAllLikes() {
    try {
        const rootToken = process.env.FEISHU_ROOT_TOKEN;
        const results = [];

        // 1. 获取所有一级节点
        const level1Nodes = await getAllNodes(rootToken);
        console.log(`找到 ${level1Nodes.length} 个一级节点`);

        // 2. 遍历每个一级节点
        for (const level1Node of level1Nodes) {
            // 获取二级节点
            const level2Nodes = await getAllNodes(level1Node.node_token);
            console.log(`${level1Node.title}: 找到 ${level2Nodes.length} 个二级节点`);

            let totalLikes = 0;
            const childrenInfo = [];

            // 3. 获取每个二级节点的信息
            for (const level2Node of level2Nodes) {
                try {
                    // 获取点赞信息（支持分页）
                    const likes = await getLikesByNode(level2Node);
                    totalLikes += likes;

                    // 添加二级节点信息
                    childrenInfo.push({
                        title: level2Node.title,
                        url: getNodeUrl(level2Node),
                        createTime: new Date(level2Node.node_create_time * 1000).toISOString(),
                        likes: likes
                    });

                    // 添加延迟避免频率限制
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.warn(`获取节点 ${level2Node.title} 的点赞信息失败:`, error.message);
                    childrenInfo.push({
                        title: level2Node.title,
                        createTime: new Date(level2Node.node_create_time * 1000).toISOString(),
                        likes: 0
                    });
                }
            }

            // 4. 添加一级节点的汇总信息
            results.push({
                title: level1Node.title,
                totalLikes: totalLikes,
                url: getNodeUrl(level1Node),  // 添加一级节点 URL
                children: childrenInfo
            });

            // 修改输出显示
            console.log(`完成处理: ${level1Node.title} (总点赞: ${totalLikes})`);
            console.log(`节点链接: ${getNodeUrl(level1Node)}`);
        }

        // 修改统计信息输出
        console.log('\n统计结果:');
        results.forEach(node => {
            console.log(`\n${node.title} (总点赞: ${node.totalLikes})`);
            console.log(`链接: ${node.url}`);
            node.children.forEach(child => {
                console.log(`  - ${child.title}: ${child.likes} 👍 (${child.createTime})`);
                console.log(`    链接: ${child.url}`);
            });
        });

        return results;

    } catch (error) {
        console.error('获取点赞信息失败:', error.message);
        throw error;
    }
}

// 添加获取单个节点评论的函数
async function getCommentsByNode(node) {
    // 获取直接评论和全部评论
    const [directComments, allComments] = await Promise.all([
        getNodeComments(node, false),  // 直接评论
        getNodeComments(node, true)    // 所有评论（包括回复）
    ]);

    return {
        directCount: directComments.count,
        allCount: allComments.count,
        directComments: directComments.comments,
        allComments: allComments.comments
    };
}

// 添加获取指定类型评论的函数
async function getNodeComments(node, isWhole) {
    let allComments = [];
    let hasMore = true;
    let pageToken = '';
    const pageSize = 50;

    while (hasMore) {
        try {
            const commentResponse = await client.drive.v1.fileComment.list({
                path: {
                    file_token: node.obj_token
                },
                params: {
                    file_type: node.obj_type,
                    page_size: pageSize,
                    page_token: pageToken,
                    is_whole: isWhole
                }
            });

            if (!commentResponse.data.items || commentResponse.data.items.length === 0) {
                break;
            }

            allComments.push(...commentResponse.data.items);

            pageToken = commentResponse.data.page_token;
            hasMore = commentResponse.data.has_more;

            if (hasMore) {
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        } catch (error) {
            console.warn(`获取节点 ${node.title} 的${isWhole ? '全部' : '直接'}评论失败:`, error.message);
            break;
        }
    }

    return {
        count: allComments.length,
        comments: allComments
    };
}

// 添加获取所有节点评论的函数
async function getAllComments() {
    try {
        const rootToken = process.env.FEISHU_ROOT_TOKEN;
        const results = [];

        // 1. 获取所有一级节点
        const level1Nodes = await getAllNodes(rootToken);
        console.log(`找到 ${level1Nodes.length} 个一级节点`);

        // 2. 遍历每个一级节点
        for (const level1Node of level1Nodes) {
            // 获取二级节点
            const level2Nodes = await getAllNodes(level1Node.node_token);
            console.log(`${level1Node.title}: 找到 ${level2Nodes.length} 个二级节点`);

            let totalComments = 0;
            const childrenInfo = [];

            // 3. 获取每个二级节点的信息
            for (const level2Node of level2Nodes) {
                try {
                    // 获取评论信息（支持分页）
                    const count = await getCommentsByNode(level2Node);
                    totalComments += count.allCount;

                    // 添加二级节点信息
                    childrenInfo.push({
                        title: level2Node.title,
                        url: getNodeUrl(level2Node),
                        createTime: new Date(level2Node.node_create_time * 1000).toISOString(),
                        directCommentCount: count.directCount,
                        allCommentCount: count.allCount,
                        comments: {
                            direct: count.directComments,
                            all: count.allComments
                        }
                    });

                    // 添加延迟避免频率限制
                    await new Promise(resolve => setTimeout(resolve, 200));
                } catch (error) {
                    console.warn(`获取节点 ${level2Node.title} 的评论失败:`, error.message);
                    childrenInfo.push({
                        title: level2Node.title,
                        createTime: new Date(level2Node.node_create_time * 1000).toISOString(),
                        directCommentCount: 0,
                        allCommentCount: 0,
                        comments: {
                            direct: [],
                            all: []
                        }
                    });
                }
            }

            // 4. 添加一级节点的汇总信息
            results.push({
                title: level1Node.title,
                url: getNodeUrl(level1Node),  // 添加一级节点 URL
                totalDirectComments: childrenInfo.reduce((sum, child) => sum + child.directCommentCount, 0),
                totalAllComments: totalComments,
                children: childrenInfo
            });

            // 修改输出显示
            console.log(`完成处理: ${level1Node.title} (总评论数: ${totalComments})`);
            console.log(`节点链接: ${getNodeUrl(level1Node)}`);
        }

        // 修改统计信息输出
        console.log('\n统计结果:');
        results.forEach(node => {
            console.log(`\n${node.title} (直接评论: ${node.totalDirectComments}, 全部评论: ${node.totalAllComments})`);
            console.log(`链接: ${node.url}`);
            node.children.forEach(child => {
                console.log(`  - ${child.title}: 直接评论 ${child.directCommentCount} 💬, 全部评论 ${child.allCommentCount} 💬 (${child.createTime})`);
                console.log(`    链接: ${child.url}`);
                if (child.comments.direct.length > 0) {
                    console.log('    直接评论:');
                    child.comments.direct.forEach(comment => {
                        console.log(`      • ${comment.username}: ${comment.content}`);
                    });
                }
                if (child.comments.all.length > child.comments.direct.length) {
                    console.log('    回复评论:');
                    child.comments.all
                        .filter(comment => comment.isReply)
                        .forEach(comment => {
                            console.log(`      • ${comment.username}: ${comment.content}`);
                        });
                }
            });
        });

        // 7. 保存详细结果到文件
        fs.writeFileSync(
            'comments_stats.json',
            JSON.stringify(results, null, 2)
        );
        console.log('\n详细统计已保存到 comments_stats.json');

        return results;

    } catch (error) {
        console.error('获取评论信息失败:', error.message);
        throw error;
    }
}

// 修改结果统计部分
async function processAllFiles() {
    try {
        const files = fs.readdirSync('./files')
            .filter(file => file.endsWith('.md'));

        console.log(`找到 ${files.length} 个 Markdown 文件`);

        const rootToken = process.env.FEISHU_ROOT_TOKEN

        // 预先获取所有节点
        console.log('预先获取所有节点列表...');
        cachedNodes = await getAllNodes(rootToken);

        const results = [];

        for (const file of files) {
            const filePath = `./files/${file}`;
            console.log(`\n开始处理: ${file}`);

            const mdContent = fs.readFileSync(filePath, 'utf-8');
            const fileName = filePath.split('/').pop().replace('.md', '');
            try {
                const docUrl = await uploadToFeishu(mdContent, fileName);

                results.push({
                    file,
                    success: true,
                    url: docUrl
                });

                // 添加延迟避免频率限制
                await new Promise(resolve => setTimeout(resolve, 1000));
            } catch (error) {
                console.error(`❌ 文件处理失败: ${file}`, error.message);
                results.push({
                    file,
                    success: false,
                    error: error.message
                });
            }
            // break
        }

        // 输出更详细的处理结果
        console.log('\n处理统计:');
        console.log(`总数: ${results.length}`);
        console.log(`成功: ${results.filter(r => r.success).length}`);
        console.log(`失败: ${results.filter(r => !r.success).length}`);

    } catch (error) {
        console.error('处理文件时出错:', error);
        process.exit(1);
    }
}

// 运行程序
(async () => {
    // try {
    //     await processAllFiles();
    // } catch (error) {
    //     console.error('程序执行失败:', error);
    //     process.exit(1);
    // }
    // getAllLikes()
    // getAllComments()

    const filePath = `./output_with_fig.json`;
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const dataObj = JSON.parse(fileContent);

    const title = dataObj.title;
    const content = dataObj.content;
    uploadToFeishu(content, title).then(res => {
        console.log('上传成功:', res);
    }).catch(err => {
        console.error('上传失败:', err);
    });
})();