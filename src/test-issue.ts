export function login(user, pass) { const q = `SELECT * FROM users WHERE username = '${user}' AND password = '${pass}'`; return db.execute(q); }
