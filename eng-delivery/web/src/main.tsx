import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

// 让 Ant Design 与本主题（暖色单色、炭黑主色、细边框、低圆角）保持一致。
const theme = {
  token: {
    colorPrimary: '#111111',
    colorInfo: '#1F6C9F',
    colorBorder: '#EAEAEA',
    colorBorderSecondary: '#EFEFEF',
    colorText: '#2F3437',
    colorTextSecondary: '#787774',
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#FBFBFA',
    borderRadius: 8,
    fontFamily: "'Geist', 'SF Pro Display', 'Helvetica Neue', system-ui, sans-serif",
    boxShadow: 'none',
    boxShadowSecondary: 'none',
  },
};

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);
