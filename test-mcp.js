import http from 'http';

const req1 = http.get('http://localhost:3000/mcp');
req1.on('response', (res) => {
  console.log('req1 status', res.statusCode);
  
  const req2 = http.get('http://localhost:3000/mcp');
  req2.on('response', (res2) => {
    console.log('req2 status', res2.statusCode);
  });
});
