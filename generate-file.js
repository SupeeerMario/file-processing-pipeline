const { createWriteStream } = require('node:fs');
const { once } = require('node:events');


const argv = process.argv.slice(2);
const broken = argv.includes('--broken');
const positional = argv.filter((a) => !a.startsWith('--'));
const rows = Number(positional[0]);
const outPath = positional[1];


if (!Number.isInteger(rows) || rows < 1 || !outPath) {
    console.error('usage: node generate-csv.js <rows> <outPath> [--broken]');
    process.exit(1);
}


const HEADER = 'name,email,country\n';
const COUNTRIES = ['US', 'CA', 'EG', 'GE', 'FR', 'JP'];



const DEFECTS = {
    7: 'comma',
    23: 'email',
    35: 'missing_name',
};



function buildRow(i) {
    let name = `User ${i}`;
    let email = `user${i}@example.com`;
    let country = COUNTRIES[i % COUNTRIES.length];

    if (broken && DEFECTS[i]) {
        switch (DEFECTS[i]) {
            case 'email':
                email = `user${i}.example.com`;
                break;
            case 'comma':
                name = `User, ${i}`;
                break;
            case 'date':
                date = '2024-13-45';
                break;
            case 'missing_name':
                name = '';
                break;
        }
    }

    return [name, email, country].join(',') + '\n';
}



async function main() {
    const stream = createWriteStream(outPath);

    stream.write(HEADER);

    for (let i = 1; i <= rows; i++) {
        const line = buildRow(i);
        if (!stream.write(line)) await once(stream, 'drain');
    }

    stream.end();
    await once(stream, 'finish');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
