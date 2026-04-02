export function login(user: string, pass: string) { 
  const db: any = {};
  const query = `SELECT * FROM users WHERE username = '${user}' AND password = '${pass}'`; 
  return db.execute(query); 
}
