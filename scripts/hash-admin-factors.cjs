'use strict';
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const { Writable } = require('node:stream');
const readline = require('node:readline/promises');
async function main() {
 if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('Güvenli etkileşimli terminal gerekli. Şifreleri komut satırı argümanlarına yazmayın.');
 const target=path.resolve(process.argv[2] || 'admin-render-verifiers.env');
 if(fs.existsSync(target))throw new Error('Çıktı dosyası mevcut. Yeni ve özel bir dosya yolu seçin.');
 const muted=new Writable({write(_chunk,_encoding,done){done();}});muted.isTTY=true;muted.columns=80;
 const rl=readline.createInterface({input:process.stdin,output:muted,terminal:true,historySize:0});
 const ask=async prompt=>{process.stderr.write(prompt);const value=await rl.question('');process.stderr.write('\n');return value;};
 const values=[];
 try {
  for(const [label,prefix] of [['4','ADMIN_GATE_FOUR'],['5','ADMIN_GATE_FIVE']]) {
   const password=(await ask(`${label}. adım şifresi (gizli): `)).normalize('NFKC');
   if(password.length<12||password.length>256)throw new Error('Şifre 12–256 karakter olmalıdır.');
   if(password!==(await ask(`${label}. adım şifresini tekrarlayın (gizli): `)).normalize('NFKC'))throw new Error('Şifreler eşleşmedi. Dosya oluşturulmadı.');
   const salt=crypto.randomBytes(32),hash=crypto.scryptSync(password,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});
   values.push(`${prefix}_SALT_HEX=${salt.toString('hex')}`,`${prefix}_HASH_HEX=${hash.toString('hex')}`);hash.fill(0);salt.fill(0);
  }
 } finally {rl.close();}
 fs.writeFileSync(target,'# Özel: yalnızca Render Environment için. Hosting veya kaynak koduna eklemeyin.\n'+values.join('\n')+'\n',{flag:'wx',mode:0o600});
 process.stderr.write('Dört doğrulama değeri oluşturuldu. Açık şifre kaydedilmedi.\n');
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
