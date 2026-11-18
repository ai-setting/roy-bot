/**
 * LSP Test Script - 包含多个类型错误和 lint 问题
 * 用于测试 LSP 服务器检测能力
 */

// 问题1: 类型错误 - number 不能赋值给 string
const userName: string = 123;

// 问题2: 未定义的变量
console.log(undefinedVariable);

// 问题3: 类型不匹配 - 函数参数类型错误
function greet(name: string): string {
  return `Hello, ${name}`;
}
greet(42); // 应该是 string，传了 number

// 问题4: 访问不存在的属性
const now = new Date();
const invalidProp = now.nonExistentProperty;

// 问题5: 缺失导入
const result = JSON.stringifai({ a: 1 }); // 拼写错误的方法名

// 问题6: 返回类型错误
function getNumber(): string {
  return 42; // 声明返回 string 但实际返回 number
}

// 问题7: 数组类型错误
const numbers: number[] = [1, 2, 'three', 4]; // 包含字符串

// 问题8: 对象字面量类型错误
const config: { host: string; port: number } = {
  host: 'localhost',
  port: '8080', // 应该是 number
};

// 问题9: 使用 undefined 值
const maybeNull: string | null = null;
maybeNull.toUpperCase(); // 可能为 null，需要空值检查

// 问题10: 循环变量类型错误
for (const i of 'hello') {
  console.log(i * 2); // string 不能乘以 number
}

export { userName, greet, getNumber };
