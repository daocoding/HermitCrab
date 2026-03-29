const fs = require('fs');
const cheerio = require('cheerio');

const inputPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/x-article-2010751592346030461/part1-zh-composited.html';
const outputPath = '/Users/yourusername/Library/CloudStorage/OneDrive-ApexLearn/JARVIS/hermitcrab/cody-workspace/x-article-2010751592346030461/article-zh-styled.html';

let rawHtml = fs.readFileSync(inputPath, 'utf8');
const $ = cheerio.load(rawHtml, null, false);

$('li').each(function(i, el) {
    let inner = $(el).html();
    // remove existing span with bullet if there is one
    inner = String(inner).replace(/<span[^>]*>[·•\s]<\/span>\s*/g, '').trim();
    // replace with pristine p
    $(el).replaceWith('<p style="margin:0px; padding-left:1em; font-size: 17px; line-height: 2; color: #2c2c2c;"><span style="color: #c9a96e; font-weight: bold; margin-right: 8px;">• </span>' + inner + '</p>');
});

$('ul, ol').each(function() {
    $(this).replaceWith($(this).html());
});

fs.writeFileSync(outputPath, $.html());
console.log("Written to article-zh-styled.html");
