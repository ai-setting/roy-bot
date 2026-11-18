/**
 * Hello World 组件示例
 * 
 * 展示 React + TypeScript + Tailwind CSS 的基本用法
 */
import { useState } from 'react';

interface GreetingProps {
  name?: string;
}

export function HelloWorld({ name = 'World' }: GreetingProps) {
  const [count, setCount] = useState(0);
  const [inputName, setInputName] = useState(name);

  return (
    <div className="p-8 text-center max-w-md mx-auto">
      {/* 标题 */}
      <h1 className="text-4xl font-bold text-blue-500 mb-2">
        🎉 Hello World!
      </h1>
      
      {/* 动态问候语 */}
      <p className="text-xl text-gray-300 mb-6">
        Welcome, <span className="text-blue-400 font-semibold">{inputName}</span>!
      </p>

      {/* 输入框 */}
      <div className="mb-6">
        <input
          type="text"
          value={inputName}
          onChange={(e) => setInputName(e.target.value)}
          placeholder="Enter your name"
          className="px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-white
                     focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500
                     transition-colors w-full"
        />
      </div>

      {/* 计数器 */}
      <div className="bg-gray-800 rounded-lg p-6 mb-6">
        <p className="text-gray-400 mb-2">Click Counter</p>
        <p className="text-5xl font-bold text-blue-400 mb-4">{count}</p>
        <div className="flex justify-center gap-4">
          <button
            onClick={() => setCount(c => c - 1)}
            className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded-lg transition-colors
                       text-white font-medium"
          >
            - Decrease
          </button>
          <button
            onClick={() => setCount(0)}
            className="px-4 py-2 bg-gray-600 hover:bg-gray-700 rounded-lg transition-colors
                       text-white font-medium"
          >
            Reset
          </button>
          <button
            onClick={() => setCount(c => c + 1)}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 rounded-lg transition-colors
                       text-white font-medium"
          >
            + Increase
          </button>
        </div>
      </div>

      {/* 信息卡片 */}
      <div className="bg-gray-800/50 rounded-lg p-4 text-left">
        <h2 className="text-lg font-semibold text-gray-200 mb-2">📚 Features</h2>
        <ul className="text-gray-400 space-y-1 text-sm">
          <li>✅ React + TypeScript</li>
          <li>✅ Tailwind CSS</li>
          <li>✅ State Management</li>
          <li>✅ Interactive Components</li>
        </ul>
      </div>

      {/* 点击提示 */}
      <p className="text-gray-500 text-sm mt-6">
        This is a demo component for Roy Agent Desktop
      </p>
    </div>
  );
}
