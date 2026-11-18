/**
 * Hello World 示例
 */

function sayHello(name: string = "World"): void {
  console.log(`Hello, ${name}!`);
}

function main(): void {
  // 基本问候
  sayHello();
  
  // 带名字的问候
  sayHello("Roy");
  
  // 使用模板字符串
  const message = `Welcome to Hello World Example!`;
  console.log(message);
}

main();
