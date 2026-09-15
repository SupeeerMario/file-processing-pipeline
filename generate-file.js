const { createWriteStream } = require('node:fs');
const { once } = require('node:events');
const ExcelJS = require('exceljs');

const argv = process.argv.slice(2);
const broken = argv.includes('--broken');
const positional = argv.filter((a) => !a.startsWith('--'));
const rows = Number(positional[0]);
const outPath = positional[1];


if (!Number.isInteger(rows) || rows < 1 || !outPath) {
    console.error('usage: node generate-csv.js <rows> <outPath> [--broken]');
    process.exit(1);
}


const HEADER = ['name', 'email', 'country'];
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

    return [name, email, country];
}



async function main() {
    let isXlsx
    let wb
    let sheet
    let stream

    if (outPath.endsWith('.xlsx')) {
        isXlsx = true
    }

    if (isXlsx) {
        wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: outPath })

        sheet = wb.addWorksheet('rows')

        sheet.addRow(HEADER).commit()

    } else {
        stream = createWriteStream(outPath);

        stream.write(HEADER.join(',') + '\n');

    }


    for (let i = 1; i <= rows; i++) {
        const line = buildRow(i);
        if (isXlsx) {
            sheet.addRow(line).commit()

        } else {
            if (!stream.write(line.join(',') + '\n')) await once(stream, 'drain');

        }

    }
    if (isXlsx) {
        await sheet.commit(); await wb.commit()

    } else {
        stream.end();

        await once(stream, 'finish');

    }


}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
