require('dotenv').config();
const fs = require('fs');
const { Client } = require('@larksuiteoapi/node-sdk');

// 初始化飞书客户端
const client = new Client({
    appId: process.env.FEISHU_APP_ID,
    appSecret: process.env.FEISHU_APP_SECRET,
    disableTokenCache: false,
});

const wiki_space_id = process.env.FEISHU_WIKI_SPACE_ID;
const app_token = process.env.FEISHU_APP_TOKEN;
const table_id = process.env.FEISHU_TABLE_ID;
const domain_name = process.env.FEISHU_DOMAIN_NAME;

// 添加缓存节点列表
let cachedNodes = null;

// 获取所有节点的函数
async function getAllNodes(rootToken) {
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

// 修改查找节点函数，使用缓存的节点列表
async function findExistingNode(rootToken, fileName) {
    try {
        // 如果还没有缓存节点列表，则获取
        if (!cachedNodes) {
            cachedNodes = await getAllNodes(rootToken);
        }

        const existingNode = cachedNodes.find(node => node.title === fileName);
        return existingNode ? existingNode.obj_token : null;
    } catch (error) {
        console.error('查找节点失败:', error.message);
        throw error;
    }
}

// 添加获取文档元数据的函数
async function getDocumentMetadata(docToken) {
    try {
        const response = await client.wiki.v2.space.getNode({
            params: {
                token: docToken
            }
        });

        // 处理创建时间
        let createTime;
        try {
            const timestamp = parseInt(response.data.node.node_create_time) * 1000;
            createTime = new Date(timestamp).toISOString().split('T')[0];
        } catch (error) {
            console.warn('创建时间格式化失败，使用当前时间');
            createTime = new Date().toISOString().split('T')[0];
        }

        return {
            createTime,
            modifyTime: new Date().toISOString().split('T')[0]
        };
    } catch (error) {
        console.error('获取文档元数据失败:', error.message);
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
    'image': 27
};

async function markdownToFeishuBlocks(mdContent) {
    const blocks = [];
    const lines = mdContent.split('\n');
    for (const line of lines) {
        // 处理标题
        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            const level = headingMatch[1].length;
            switch (level) {
                case 1:
                    blocks.push({
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
                    blocks.push({
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
                    blocks.push({
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
                    blocks.push({
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
                    blocks.push({
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
                    blocks.push({
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
            blocks.push({
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
            blocks.push({
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
            blocks.push({
                block_type: BLOCK_TYPE_MAP.divider,  // 使用数字类型 22
                divider: {}
            });
            continue;
        }

        // 处理普通段落
        if (line.trim()) {
            // 处理行内格式
            const elements = processInlineFormatting(line);
            blocks.push({
                block_type: BLOCK_TYPE_MAP.text,  // 使用数字类型 2
                text: {
                    elements: elements
                }
            });
        }
    }

    return blocks;
}

// 处理行内格式（加粗、斜体、链接等）
function processInlineFormatting(text) {
    const parts = [];
    let currentText = '';
    let i = 0;

    while (i < text.length) {
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
                    content: match[1]
                },
                text_element_style: {
                    bold: true
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
                    content: match[1]
                },
                text_element_style: {
                    italic: true
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

// 添加更新多维表格的函数
async function updateBitableRecord(fileName, docUrl) {
    try {
        const response = await client.bitable.v1.appTableRecord.search({
            path: {
                app_token: app_token,
                table_id: table_id
            },
            params: {
                filter: {
                    conjunction: "and",
                    conditions: [
                        {
                            conditions: 'Title',
                            operator: "is",
                            value: fileName
                        }
                    ]
                }
            }
        });

        // 更新现有记录
        const recordId = response.data.items[0].record_id;
        // 获取创建时间，如果不存在则使用当前时间
        const contentModified = new Date().now();
        const contentCreated = response.data?.items?.[0]?.fields?.['Content Created'] ?? new contentModified;

        await client.bitable.v1.appTableRecord.update({
            path: {
                app_token: app_token,
                table_id: table_id,
                record_id: recordId
            },
            data: {
                fields: {
                    "Content": {
                        "text": "Click Here",
                        "link": docUrl
                    },
                    "Content Created": contentCreated,
                    "Content Modified": contentModified
                }
            }
        });
        console.log('✅ 已更新现有记录');

    } catch (error) {
        console.error('更新多维表格失败:', error.message);
        throw error;
    }
}

// 修改上传函数，支持更新现有文档
async function uploadToFeishu(mdContent, fileName) {
    try {
        const rootToken = process.env.FEISHU_ROOT_TOKEN
        // 1. 查找或创建父节点 A
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
        const childTitle = `${currentDate.toISOString().split('T')[0]}_${fileName}`;

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

        // 3. 将内容写入节点 B
        const blocks = await markdownToFeishuBlocks(mdContent);
        const blockChunks = chunkBlocks(blocks);

        console.log('开始上传内容...');
        let currentIndex = 0;
        for (const chunk of blockChunks) {
            await client.docx.v1.documentBlockChildren.create({
                path: {
                    document_id: childObjToken,
                    block_id: childObjToken
                },
                data: {
                    children: chunk,
                    index: currentIndex
                }
            });

            currentIndex += chunk.length;
            const progress = Math.round((currentIndex / blocks.length) * 100);
            process.stdout.write(`\r正在上传内容... ${progress}% [${currentIndex}/${blocks.length}]`);
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // 4. 获取节点 B 的链接
        const childUrl = `https://${domain_name}.feishu.cn/wiki/${childToken}`;

        // 5. 更新父节点 A 的内容
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
                index: 0
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
    getAllComments()
})();