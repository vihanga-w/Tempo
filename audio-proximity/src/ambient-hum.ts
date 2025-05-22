/**
 * Specialized similarity processor for ambient hum/drone detection
 * Focuses on spectral characteristics rather than temporal dynamics
 */

import { FrameItem } from ".";

/**
 * Extract spectral profile from a sequence of frames
 * Emphasizes frequency content over time-based features
 */
function extractSpectralProfile(buffer: FrameItem[]): {
    avgMfcc: number[];
    spectralCentroidMean: number;
    spectralCentroidStd: number;
    spectralFlatnessMean: number;
    spectralFlatnessStd: number;
    perceptualSpreadMean: number;
    perceptualSpreadStd: number;
    harmonicStability: number;
    spectralRolloff: number;
} {
    // Calculate means and standard deviations for spectral features
    const spectralCentroids = buffer.map(f => f.spectralCentroid);
    const spectralFlatness = buffer.map(f => f.spectralFlatness);
    const perceptualSpreads = buffer.map(f => f.perceptualSpread);
    
    // Average MFCC across time to get spectral signature
    const mfccMatrix = buffer.map(f => f.mfcc);
    const avgMfcc = Array.from({ length: mfccMatrix[0].length }, (_, i) =>
        mfccMatrix.reduce((sum, mfcc) => sum + mfcc[i], 0) / mfccMatrix.length
    );
    
    // Calculate stability metrics
    const centroidMean = spectralCentroids.reduce((a, b) => a + b, 0) / spectralCentroids.length;
    const centroidStd = Math.sqrt(
        spectralCentroids.reduce((sum, x) => sum + Math.pow(x - centroidMean, 2), 0) / spectralCentroids.length
    );
    
    const flatnessMean = spectralFlatness.reduce((a, b) => a + b, 0) / spectralFlatness.length;
    const flatnessStd = Math.sqrt(
        spectralFlatness.reduce((sum, x) => sum + Math.pow(x - flatnessMean, 2), 0) / spectralFlatness.length
    );
    
    const spreadMean = perceptualSpreads.reduce((a, b) => a + b, 0) / perceptualSpreads.length;
    const spreadStd = Math.sqrt(
        perceptualSpreads.reduce((sum, x) => sum + Math.pow(x - spreadMean, 2), 0) / perceptualSpreads.length
    );
    
    // Harmonic stability - lower values indicate more stable harmonic content
    const harmonicStability = 1.0 / (1.0 + centroidStd + flatnessStd);
    
    // Spectral rolloff approximation using centroid and spread
    const spectralRolloff = centroidMean + (spreadMean * 0.85);
    
    return {
        avgMfcc,
        spectralCentroidMean: centroidMean,
        spectralCentroidStd: centroidStd,
        spectralFlatnessMean: flatnessMean,
        spectralFlatnessStd: flatnessStd,
        perceptualSpreadMean: spreadMean,
        perceptualSpreadStd: spreadStd,
        harmonicStability,
        spectralRolloff
    };
}

/**
 * Calculate spectral distance between two spectral profiles
 * Designed specifically for ambient hum comparison
 */
function calculateSpectralDistance(profileA: ReturnType<typeof extractSpectralProfile>, 
                                 profileB: ReturnType<typeof extractSpectralProfile>): number {
    
    // MFCC distance with emphasis on lower coefficients (fundamental frequencies)
    const mfccWeights = Array.from({ length: profileA.avgMfcc.length }, (_, i) => 
        Math.exp(-0.15 * i) // Even stronger emphasis on lower coefficients for ambient sounds
    );
    
    let mfccDistance = 0;
    for (let i = 0; i < profileA.avgMfcc.length; i++) {
        const diff = profileA.avgMfcc[i] - profileB.avgMfcc[i];
        mfccDistance += diff * diff * mfccWeights[i];
    }
    mfccDistance = Math.sqrt(mfccDistance);
    
    // Spectral centroid distance (frequency center of mass)
    const centroidDistance = Math.abs(profileA.spectralCentroidMean - profileB.spectralCentroidMean) / 1000; // Normalize
    
    // Spectral flatness distance (tonal vs noise-like character)
    const flatnessDistance = Math.abs(profileA.spectralFlatnessMean - profileB.spectralFlatnessMean);
    
    // Perceptual spread distance (frequency spread)
    const spreadDistance = Math.abs(profileA.perceptualSpreadMean - profileB.perceptualSpreadMean) / 100; // Normalize
    
    // Harmonic stability distance (how stable the harmonic content is)
    const stabilityDistance = Math.abs(profileA.harmonicStability - profileB.harmonicStability);
    
    // Spectral rolloff distance (high frequency cutoff point)
    const rolloffDistance = Math.abs(profileA.spectralRolloff - profileB.spectralRolloff) / 1000; // Normalize
    
    // Weighted combination - emphasize MFCC and spectral characteristics
    const combinedDistance = (
        mfccDistance * 0.4 +           // Primary spectral signature
        centroidDistance * 0.2 +       // Frequency center
        flatnessDistance * 0.15 +      // Tonal character
        spreadDistance * 0.1 +         // Frequency spread
        stabilityDistance * 0.1 +      // Harmonic stability
        rolloffDistance * 0.05         // High frequency rolloff
    );
    
    return combinedDistance;
}

/**
 * Compute ambient hum similarity using spectral profile matching
 * Returns similarity score between 0 and 1
 */
function computeAmbientHumSimilarity(bufferA: FrameItem[], bufferB: FrameItem[]): number {
    // Extract spectral profiles for both buffers
    const profileA = extractSpectralProfile(bufferA);
    const profileB = extractSpectralProfile(bufferB);
    
    // Calculate spectral distance
    const distance = calculateSpectralDistance(profileA, profileB);
    
    // Convert distance to similarity with ambient-specific scaling
    // Ambient sounds typically have smaller variations, so we use a tighter scaling
    const similarity = Math.exp(-distance * 3.0); // Tighter scaling for ambient sounds
    
    // Apply harmonic bonus - ambient hums with similar harmonic stability get bonus
    const harmonicBonus = Math.min(profileA.harmonicStability, profileB.harmonicStability) * 0.1;
    
    // Apply spectral consistency bonus - sounds with similar spectral flatness get bonus
    const flatnessConsistency = 1.0 - Math.abs(profileA.spectralFlatnessMean - profileB.spectralFlatnessMean);
    const consistencyBonus = Math.max(0, flatnessConsistency - 0.5) * 0.1;
    
    // Final similarity with bonuses
    const finalSimilarity = Math.min(1.0, similarity + harmonicBonus + consistencyBonus);
    
    return finalSimilarity;
}

/**
 * Alternative ambient hum processor using frequency bin analysis
 * More granular approach for very similar ambient sounds
 */
function computeAmbientHumSimilarityAdvanced(bufferA: FrameItem[], bufferB: FrameItem[]): number {
    // Create frequency histograms from MFCC coefficients
    const createFreqHistogram = (buffer: FrameItem[]) => {
        const histogram = new Array(13).fill(0); // MFCC typically has 13 coefficients
        
        buffer.forEach(frame => {
            frame.mfcc.forEach((coeff, i) => {
                if (i < histogram.length) {
                    // Convert to magnitude and accumulate
                    histogram[i] += Math.abs(coeff);
                }
            });
        });
        
        // Normalize histogram
        const total = histogram.reduce((a, b) => a + b, 0);
        return histogram.map(val => val / total);
    };
    
    const histA = createFreqHistogram(bufferA);
    const histB = createFreqHistogram(bufferB);
    
    // Calculate histogram correlation
    let correlation = 0;
    for (let i = 0; i < histA.length; i++) {
        correlation += histA[i] * histB[i];
    }
    
    // Normalize correlation to similarity
    const histogramSimilarity = Math.pow(correlation, 0.5); // Square root for softer scaling
    
    // Combine with spectral profile similarity
    const spectralSimilarity = computeAmbientHumSimilarity(bufferA, bufferB);
    
    // Weighted combination
    return histogramSimilarity * 0.6 + spectralSimilarity * 0.4;
}

// Export the functions for use in the main processor
export {
    extractSpectralProfile,
    calculateSpectralDistance,
    computeAmbientHumSimilarity,
    computeAmbientHumSimilarityAdvanced
};