const express = require('express');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const app = express();
app.use(express.json({ limit: '50mb' }));

// Baixa arquivo da web para o disco temporário da nuvem
async function downloadFile(url, destPath) {
    const writer = fs.createWriteStream(destPath);
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        timeout: 20000
    });
    response.data.pipe(writer);
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

app.post('/render', async (req, res) => {
    const { audio_url, slides, animations, format } = req.body;
    if (!audio_url || !slides || !slides.length) {
        return res.status(400).send('Dados incompletos');
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-render-'));
    const targetFormat = format || 'mp4';
    const outputVideo = path.join(tempDir, `output.${targetFormat}`);
    const audioPath = path.join(tempDir, 'audio.mp3');

    try {
        // 1. Baixa o áudio da sua hospedagem
        await downloadFile(audio_url, audioPath);

        // 2. Baixa as imagens da sua hospedagem
        const localSlides = [];
        for (let i = 0; i < slides.length; i++) {
            const imgPath = path.join(tempDir, `slide_${i}.webp`);
            await downloadFile(slides[i].url, imgPath);
            localSlides.push({ file: imgPath, duration: slides[i].duration });
        }

        const transType = animations?.transition?.type || 'none';
        const transDur = parseFloat(animations?.transition?.duration) || 0.5;
        const introType = animations?.intro?.type || 'none';
        const introDur = parseFloat(animations?.intro?.duration) || 0.5;
        const outroType = animations?.outro?.type || 'none';
        const outroDur = parseFloat(animations?.outro?.duration) || 0.5;

        const xfadeMap = {
            fade: 'fade', zoom_in: 'zoomin', zoom_out: 'zoomout',
            slide_left: 'slideleft', slide_up: 'slideup', blur_fade: 'dissolve'
        };
        const selectedXfade = xfadeMap[transType] || null;

        let inputArgs = '';
        let filterComplex = '';
        const scaleFilter = 'scale=w=1280:h=720:force_original_aspect_ratio=decrease:flags=fast_bilinear,pad=1280:720:(1280-iw)/2:(720-ih)/2:black,setsar=1';

        if (localSlides.length > 1 && selectedXfade) {
            localSlides.forEach((sf, i) => {
                inputArgs += `-loop 1 -t ${(sf.duration + transDur).toFixed(4)} -i "${sf.file}" `;
                filterComplex += `[${i}:v]${scaleFilter},format=yuv420p,fps=24,settb=AVTB[v${i}];\n`;
            });

            let currentOffset = 0.0;
            let lastOut = '[v0]';

            for (let i = 1; i < localSlides.length; i++) {
                currentOffset += localSlides[i - 1].duration;
                const outLabel = (i === localSlides.length - 1) ? '[vtrans]' : `[vx${i}]`;
                filterComplex += `${lastOut}[v${i}]xfade=transition=${selectedXfade}:duration=${transDur.toFixed(4)}:offset=${currentOffset.toFixed(4)}${outLabel};\n`;
                lastOut = outLabel;
            }
        } else {
            const concatFile = path.join(tempDir, 'concat.txt');
            let concatContent = '';
            localSlides.forEach(sf => {
                concatContent += `file '${sf.file}'\nduration ${sf.duration.toFixed(4)}\n`;
            });
            concatContent += `file '${localSlides[localSlides.length - 1].file}'\n`;
            fs.writeFileSync(concatFile, concatContent);
            inputArgs = `-f concat -safe 0 -i "${concatFile}" `;
            filterComplex = `[0:v]${scaleFilter},format=yuv420p,fps=24,settb=AVTB[vtrans];\n`;
        }

        let fadeEffects = '';
        if (introType === 'fade_black' || introType === 'zoom_in' || introType === 'slide_up') {
            fadeEffects += `fade=t=in:st=0:d=${introDur.toFixed(4)},`;
        } else if (introType === 'flash') {
            fadeEffects += `fade=t=in:st=0:d=${introDur.toFixed(4)}:color=white,`;
        }

        let finalVideoLabel = '[vtrans]';
        fadeEffects = fadeEffects.replace(/,$/, '');
        if (fadeEffects) {
            filterComplex += `[vtrans]${fadeEffects}[vfinal];\n`;
            finalVideoLabel = '[vfinal]';
        }

        filterComplex = filterComplex.replace(/;\s*$/, '');
        const scriptFile = path.join(tempDir, 'filter.txt');
        fs.writeFileSync(scriptFile, filterComplex);

        const audioIndex = (localSlides.length > 1 && selectedXfade) ? localSlides.length : 1;
        const cmd = `ffmpeg -y ${inputArgs} -i "${audioPath}" -filter_complex_script "${scriptFile}" -map "${finalVideoLabel}" -map ${audioIndex}:a? -c:v libx264 -preset ultrafast -tune stillimage -threads 0 -b:v 1500k -c:a aac -b:a 128k -shortest -movflags +faststart "${outputVideo}"`;

        // Executa o FFmpeg nativo na CPU potente do Google Cloud
        exec(cmd, { timeout: 60000 }, (error) => {
            if (error || !fs.existsSync(outputVideo)) {
                fs.rmSync(tempDir, { recursive: true, force: true });
                return res.status(500).send('Erro na renderização FFmpeg na nuvem');
            }

            res.setHeader('Content-Type', targetFormat === 'webm' ? 'video/webm' : 'video/mp4');
            const stream = fs.createReadStream(outputVideo);
            stream.pipe(res);
            stream.on('close', () => {
                fs.rmSync(tempDir, { recursive: true, force: true });
            });
        });

    } catch (err) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        res.status(500).send(err.message);
    }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Google Cloud Render Worker rodando na porta ${PORT}`));