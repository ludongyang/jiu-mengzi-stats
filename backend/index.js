const express = require('express');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== 安全中间件 ====================
app.use(helmet());
app.use(cors({
    origin: [
        'http://localhost:5500',
        'http://127.0.0.1:5500',
        'https://*.github.io',
        'https://你的用户名.github.io'
    ],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// 请求体大小限制
app.use(bodyParser.json({ limit: '10mb' }));

// 速率限制
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15分钟
    max: 100, // 每个IP限制100个请求
    message: { error: '请求过于频繁，请稍后再试' }
});
app.use('/api/', limiter);

// ==================== GitHub配置 ====================
const GITHUB_CONFIG = {
    owner: process.env.GITHUB_OWNER,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || 'main',
    dataPath: 'data/drink_data.json'
};

// 初始化Octokit
const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

// ==================== 辅助函数 ====================
// 获取文件的SHA
async function getFileSha(path) {
    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_CONFIG.owner,
            repo: GITHUB_CONFIG.repo,
            path: path,
            ref: GITHUB_CONFIG.branch
        });
        return data.sha;
    } catch (error) {
        if (error.status === 404) {
            return null; // 文件不存在
        }
        throw error;
    }
}

// 读取数据文件
async function readDataFile() {
    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_CONFIG.owner,
            repo: GITHUB_CONFIG.repo,
            path: GITHUB_CONFIG.dataPath,
            ref: GITHUB_CONFIG.branch
        });
        
        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        return JSON.parse(content);
    } catch (error) {
        if (error.status === 404) {
            // 文件不存在，返回空对象
            return {};
        }
        console.error('读取数据文件失败:', error);
        throw error;
    }
}

// 写入数据文件
async function writeDataFile(data) {
    try {
        const content = JSON.stringify(data, null, 2);
        const contentEncoded = Buffer.from(content).toString('base64');
        const sha = await getFileSha(GITHUB_CONFIG.dataPath);
        
        const params = {
            owner: GITHUB_CONFIG.owner,
            repo: GITHUB_CONFIG.repo,
            path: GITHUB_CONFIG.dataPath,
            message: `更新饮酒数据 - ${new Date().toISOString()}`,
            content: contentEncoded,
            branch: GITHUB_CONFIG.branch,
            sha: sha // 如果文件不存在，sha为null，会创建新文件
        };
        
        const response = await octokit.repos.createOrUpdateFileContents(params);
        return response.data;
    } catch (error) {
        console.error('写入数据文件失败:', error);
        throw error;
    }
}

// ==================== API路由 ====================
// 健康检查
app.get('/health', (req, res) => {
    res.json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        service: 'jiu-mengzi-api'
    });
});

// 加载数据
app.get('/api/load', async (req, res) => {
    try {
        const data = await readDataFile();
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            data: data
        });
    } catch (error) {
        console.error('加载数据失败:', error);
        res.status(500).json({
            success: false,
            message: '加载数据失败',
            error: error.message
        });
    }
});

// 保存数据
app.post('/api/save', async (req, res) => {
    try {
        const { date, data } = req.body;
        
        if (!date || !data) {
            return res.status(400).json({
                success: false,
                message: '缺少必要参数：date和data'
            });
        }
        
        // 验证日期格式
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                message: '日期格式不正确，应为YYYY-MM-DD'
            });
        }
        
        // 读取现有数据
        let allData = await readDataFile();
        
        // 更新指定日期的数据
        allData[date] = data;
        
        // 写入到GitHub
        await writeDataFile(allData);
        
        res.json({
            success: true,
            message: '数据保存成功',
            timestamp: new Date().toISOString(),
            date: date
        });
        
    } catch (error) {
        console.error('保存数据失败:', error);
        
        // 根据错误类型返回不同的状态码
        let statusCode = 500;
        let errorMessage = '保存数据失败';
        
        if (error.status === 401 || error.status === 403) {
            statusCode = 401;
            errorMessage = 'GitHub认证失败，请检查Token权限';
        } else if (error.status === 404) {
            statusCode = 404;
            errorMessage = 'GitHub仓库或分支不存在';
        }
        
        res.status(statusCode).json({
            success: false,
            message: errorMessage,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// 获取统计数据
app.get('/api/stats', async (req, res) => {
    try {
        const data = await readDataFile();
        
        // 计算统计信息
        const stats = {
            totalDays: Object.keys(data).length,
            lastUpdated: null,
            memberStats: {},
            wineStats: {
                baijiu: 0,
                beer: 0,
                red: 0,
                qingdao: 0,
                totalBeer: 0
            }
        };
        
        // 遍历所有数据
        Object.entries(data).forEach(([date, dateData]) => {
            Object.entries(dateData).forEach(([member, memberData]) => {
                // 初始化成员统计
                if (!stats.memberStats[member]) {
                    stats.memberStats[member] = {
                        baijiu: 0,
                        beer: 0,
                        red: 0,
                        qingdao: 0,
                        totalBeer: 0,
                        days: new Set()
                    };
                }
                
                // 累加成员数据
                stats.memberStats[member].baijiu += parseFloat(memberData.baijiu) || 0;
                stats.memberStats[member].beer += parseFloat(memberData.beer) || 0;
                stats.memberStats[member].red += parseFloat(memberData.red) || 0;
                stats.memberStats[member].qingdao += parseFloat(memberData.qingdao) || 0;
                stats.memberStats[member].days.add(date);
                
                // 计算啤酒总量
                const memberBeerTotal = (memberData.baijiu * 3) + (memberData.beer * 1) + 
                                      (memberData.red * 4.125) + (memberData.qingdao * 0.775);
                stats.memberStats[member].totalBeer += memberBeerTotal;
                
                // 累加总酒量
                stats.wineStats.baijiu += parseFloat(memberData.baijiu) || 0;
                stats.wineStats.beer += parseFloat(memberData.beer) || 0;
                stats.wineStats.red += parseFloat(memberData.red) || 0;
                stats.wineStats.qingdao += parseFloat(memberData.qingdao) || 0;
                stats.wineStats.totalBeer += memberBeerTotal;
            });
        });
        
        // 计算最后更新日期
        const dates = Object.keys(data).sort();
        if (dates.length > 0) {
            stats.lastUpdated = dates[dates.length - 1];
        }
        
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            stats: stats
        });
        
    } catch (error) {
        console.error('获取统计失败:', error);
        res.status(500).json({
            success: false,
            message: '获取统计失败',
            error: error.message
        });
    }
});

// 批量导入数据
app.post('/api/import', async (req, res) => {
    try {
        const { data: importData } = req.body;
        
        if (!importData || typeof importData !== 'object') {
            return res.status(400).json({
                success: false,
                message: '无效的数据格式'
            });
        }
        
        // 读取现有数据
        let allData = await readDataFile();
        
        // 合并数据（新数据覆盖旧数据）
        Object.assign(allData, importData);
        
        // 写入到GitHub
        await writeDataFile(allData);
        
        res.json({
            success: true,
            message: `成功导入 ${Object.keys(importData).length} 天的数据`,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('导入数据失败:', error);
        res.status(500).json({
            success: false,
            message: '导入数据失败',
            error: error.message
        });
    }
});

// 404处理
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'API端点不存在',
        availableEndpoints: [
            'GET /health',
            'GET /api/load',
            'POST /api/save',
            'GET /api/stats',
            'POST /api/import'
        ]
    });
});

// 错误处理中间件
app.use((err, req, res, next) => {
    console.error('服务器错误:', err);
    res.status(500).json({
        success: false,
        message: '服务器内部错误',
        error: process.env.NODE_ENV === 'development' ? err.message : '内部错误'
    });
});

// ==================== 启动服务器 ====================
app.listen(PORT, () => {
    console.log(`酒蒙子协会API服务启动成功！`);
    console.log(`服务器运行在: http://localhost:${PORT}`);
    console.log(`健康检查: http://localhost:${PORT}/health`);
    console.log(`GitHub仓库: ${GITHUB_CONFIG.owner}/${GITHUB_CONFIG.repo}`);
});