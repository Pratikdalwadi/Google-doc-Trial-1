/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { GoogleGenAI, Type } from '@google/genai';

// Fix: Declare pdfjsLib to resolve "Cannot find name 'pdfjsLib'" error.
declare var pdfjsLib: any;

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const fileUpload = document.getElementById('file-upload') as HTMLInputElement;
const fileNameSpan = document.getElementById('file-name');
const uploadError = document.getElementById('upload-error') as HTMLSpanElement;
const extractButton = document.getElementById(
  'extract-button',
) as HTMLButtonElement;
const markdownResultsContainer = document.getElementById('markdown-results');
const jsonResultsContainer = document.getElementById('json-results');
const loadingSpinner = document.getElementById('loading-spinner');
const previewContainer = document.getElementById('preview-container');
const tabsContainer = document.querySelector('.tabs');
const tabButtons = document.querySelectorAll('.tab-button');
const tabPanels = document.querySelectorAll('.tab-panel');
const exportButton = document.getElementById(
  'export-button',
) as HTMLButtonElement;
const exportDropdown = document.getElementById('export-dropdown');
const exportCsvButton = document.getElementById('export-csv');
const exportTxtButton = document.getElementById('export-txt');
const ocrSlider = document.getElementById(
  'ocr-threshold-slider',
) as HTMLInputElement;
const ocrValueSpan = document.getElementById('ocr-threshold-value');
const feedbackContainer = document.getElementById('feedback-container');
const feedbackGoodButton = document.getElementById(
  'feedback-good',
) as HTMLButtonElement;
const feedbackBadButton = document.getElementById(
  'feedback-bad',
) as HTMLButtonElement;
const feedbackThanksSpan = document.getElementById('feedback-thanks');

let file: File | null = null;
let fileData: {
  mimeType: string;
  data: string;
} | null = null;
let pageDimensions: { width: number; height: number }[] = [];
let extractedData: any[] = [];
let isThrottled = false;
let lastHoveredElementIndex = -1;
// State for the bounding box editor
let currentlyEditing: {
  index: number;
  originalElement: any; // A deep copy for cancellation
} | null = null;

// The schema is now a constant to be used for both the API call and the UI display.
const EXTRACTION_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    extracted_elements: {
      type: Type.ARRAY,
      description: 'An array of all elements extracted from the document.',
      items: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description:
              "The type of element. Must be one of: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.",
          },
          label: {
            type: Type.STRING,
            description:
              'The label or key for a field, or a title for a table/paragraph.',
          },
          value: {
            type: Type.STRING,
            description:
              "The extracted text value or a description for visual elements. Not used for 'table' or 'field_group' types.",
          },
          page: {
            type: Type.INTEGER,
            description:
              'The page number where the element was found (starting from 1).',
          },
          bounding_box: {
            type: Type.OBJECT,
            properties: {
              left: { type: Type.NUMBER },
              top: { type: Type.NUMBER },
              right: { type: Type.NUMBER },
              bottom: { type: Type.NUMBER },
            },
            description:
              "Normalized coordinates of the element's bounding box, with {left, top, right, bottom} properties. The origin (0,0) is the top-left corner of the page. For a 'field_group', this should encompass all fields in the group.",
          },
          line_boxes: {
            type: Type.ARRAY,
            description:
              'For multi-line text elements, an array of bounding boxes for each individual text line to allow for a tighter visual fit. Each box MUST be in the {left, top, right, bottom} format.',
            items: {
              type: Type.OBJECT,
              properties: {
                left: { type: Type.NUMBER },
                top: { type: Type.NUMBER },
                right: { type: Type.NUMBER },
                bottom: { type: Type.NUMBER },
              },
            },
          },
          table_data: {
            type: Type.OBJECT,
            description:
              "Contains header and row data. Only present if type is 'table'.",
            properties: {
              headers: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'The column headers of the table.',
              },
              rows: {
                type: Type.ARRAY,
                items: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description:
                    "An array of strings representing a single row's cells.",
                },
                description: 'The data rows of the table.',
              },
            },
          },
          fields: {
            type: Type.ARRAY,
            description:
              "An array of individual fields. Only present if type is 'field_group'.",
            items: {
              type: Type.OBJECT,
              properties: {
                label: { type: Type.STRING },
                value: { type: Type.STRING },
              },
            },
          },
        },
      },
    },
  },
};

// --- Core Extraction Logic ---
async function runExtraction() {
  if (!file || !fileData) return;

  // Cancel any ongoing edit before running a new extraction
  if (currentlyEditing) {
    exitEditMode(false);
  }

  loadingSpinner.classList.remove('hidden');
  clearResults();
  clearBoundingBoxes();

  try {
    const ocrThreshold = parseInt(ocrSlider.value, 10);
    const prompt = `You are an Agentic Document Extraction system. Your primary goal is to perform a comprehensive analysis of the uploaded document and return structured, accurate data with intelligent grouping and precise visual traceability.

**Core Instructions:**
1.  **Analyze Document Type & OCR:** Detect if the document is a PDF or an image. For images, perform Optical Character Recognition (OCR) to read all text accurately before proceeding with extraction.
2.  **OCR Confidence Threshold:** For image-based documents, you MUST only consider text recognized with a confidence level of ${ocrThreshold}% or higher. Discard any text below this threshold.
3.  **Intelligent Grouping (Highest Priority):** You MUST actively identify and group logically related fields into a \`field_group\`. This is crucial for creating a clean, organized, and human-readable output. Examples of good grouping include:
    -   Patient Information (Name, DOB, Age, etc.)
    -   Provider Information (Name, Address, Phone, etc.)
    -   An entire address block (street, city, state, zip).
    Always prefer grouping over listing individual fields when a logical connection exists.
4.  **Comprehensive Extraction:** You must extract ALL data from the document (meeting the confidence threshold). Leave nothing out.
5.  **Sequential Ordering:** The elements in the final 'extracted_elements' array must be sorted to strictly follow the top-to-bottom reading order of the source document.
6.  **Hyper-Precise Bounding Box Coordinates (CRITICAL):** For every element, you MUST provide coordinates in a **normalized {left, top, right, bottom} format**. This is the most critical part of your task. Precision is paramount.
    - The origin (0,0) is the top-left corner of the page.
    - \`left\`: The distance from the left edge of the page to the left edge of the box (0.0 to 1.0).
    - \`top\`: The distance from the top edge of the page to the top edge of the box (0.0 to 1.0).
    - \`right\`: The distance from the left edge of the page to the right edge of the box (0.0 to 1.0).
    - \`bottom\`: The distance from the top edge of the page to the bottom edge of the box (0.0 to 1.0).
    - Provide up to 5 decimal places for precision.
7.  **Crucial Rules for Bounding Box Perfection:**
    - **Pixel-Tight Fit:** The bounding box MUST be as tight as possible to the visible pixels of the text or element. There should be NO excessive padding or whitespace included inside the box.
    - **Complete Enclosure:** Despite being tight, the box MUST completely encompass the entire logical element. Do not cut off parts of letters or symbols.
    - **Handling Spaced/Fragmented Text (HIGH PRIORITY):** For text elements composed of multiple words with significant spacing between them (e.g., a "THANK YOU" sign spread across a page), you MUST treat it as a *single element*. The bounding box MUST start at the beginning of the first character of the first word (e.g., 'T') and end at the very end of the last character of the last word (e.g., 'U'), forming one single, all-encompassing rectangle.
    - **Failure Condition Example:** For the text "First Name      John", creating one box for "First Name" and another for "John" is a failure if they represent a single logical field. You must identify it as a 'field' with label 'First Name' and value 'John' and create a bounding box that encloses BOTH parts.
    - **DO NOT** create a bounding box around empty space. If an element's value is on a different part of the page from its label, the main \`bounding_box\` should cover both, and individual \`line_boxes\` can be used for the separate visual components.
8.  **Granular Line Boxes for Tighter Fit:** For any element containing text that visibly spans multiple lines on the document (e.g., 'paragraph', long 'field' values), you MUST ALSO provide a 'line_boxes' array. Each item in this array should be a precise bounding box for a single line of text, also in the {left, top, right, bottom} format. This is crucial for creating a tight visual highlight.
9.  **Element Categorization:** Classify each extracted element into one of the following types: 'field', 'field_group', 'table', 'paragraph', 'checkbox', 'logo', 'figure', 'marginalia', 'attestation'.

**Type-Specific Instructions:**
-   **field_group:** This is the preferred way to organize data. Use it liberally for sets of logically related fields. The 'bounding_box' for a group MUST encompass all of its child fields. Provide a clear and descriptive 'label' for the group (e.g., "Patient Information").
-   **field:** A simple key-value pair. Use this ONLY for individual fields that do not logically belong to any larger group. If the 'value' spans multiple lines, populate the 'line_boxes' array.
-   **paragraph:** A block of free-form text. If it spans multiple lines, you MUST populate the 'line_boxes' array.
-   **table:** Structured data in rows and columns. Populate the 'table_data' object.
-   **logo / figure:** For visual elements like logos or images, set the type accordingly and provide a detailed description of the visual content in the 'value' field.
-   **marginalia:** Text outside the main content block, like page numbers or headers/footers.
-   **attestation:** Signature blocks or electronic signature confirmations.

**Failure Condition:**
- If an image is of such low quality that OCR is impossible or produces nonsensical text, you MUST return an empty 'extracted_elements' array.

The output must be a single, valid JSON object that strictly adheres to the provided schema, with no additional text or explanations.`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: {
        parts: [
          {
            text: prompt,
          },
          {
            inlineData: fileData,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: EXTRACTION_SCHEMA,
      },
    });

    const parsedResult = JSON.parse(response.text);
    extractedData = parsedResult.extracted_elements || [];

    // Add specific guidance for low-quality images that result in empty extraction.
    if (extractedData.length === 0 && file?.type.startsWith('image/')) {
      markdownResultsContainer.innerHTML = `
        <div class="error-panel">
          <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>
          <div>
            <strong>OCR Quality Alert</strong>
            <p>The text in the uploaded image could not be read clearly. For best results, please upload a higher-resolution image with good lighting and clear, typed text.</p>
          </div>
        </div>`;
      displayJsonResults({
        error: 'OCR_QUALITY_LOW',
        message:
          'The model returned no data, likely due to a low-quality source image.',
      });
      setActiveTab('markdown');
      exportButton.disabled = true;
      feedbackContainer?.classList.add('hidden');
    } else {
      // Original logic for successful extraction
      displayMarkdownResults(extractedData);
      displayJsonResults(parsedResult);
      exportButton.disabled = extractedData.length === 0;
      // Show feedback controls
      if (feedbackContainer && extractedData.length > 0) {
        feedbackContainer.classList.remove('hidden');
        feedbackGoodButton.disabled = false;
        feedbackBadButton.disabled = false;
        feedbackThanksSpan.classList.add('hidden');
      }
      setActiveTab('markdown');
    }
  } catch (error) {
    console.error('Error extracting data:', error);
    markdownResultsContainer.innerHTML = `
    <div class="error-panel">
      <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 0 24 24" width="24px"><path d="M0 0h24v24H0V0z" fill="none"/><path d="M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z"/></svg>
      <div>
        <strong>Extraction Failed</strong>
        <p>The model could not process the document. This can happen with complex layouts, handwritten text, or low-quality scans. Please try again with a clearer document.</p>
      </div>
    </div>`;
    setActiveTab('markdown');
    extractedData = [];
    exportButton.disabled = true;
    feedbackContainer?.classList.add('hidden');
  } finally {
    loadingSpinner.classList.add('hidden');
  }
}

// --- Event Listeners ---

fileUpload.addEventListener('change', async (event) => {
  const target = event.target as HTMLInputElement;
  if (target.files && target.files[0]) {
    const selectedFile = target.files[0];
    const supportedTypes = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ];

    if (!supportedTypes.includes(selectedFile.type)) {
      uploadError.textContent = `Unsupported file type: '${selectedFile.type}'. Please upload a PDF, JPEG, PNG, GIF, or WebP.`;
      uploadError.classList.remove('hidden');
      // Reset state
      fileUpload.value = '';
      fileNameSpan.textContent = 'No file chosen';
      extractButton.disabled = true;
      ocrSlider.disabled = true;
      file = null;
      return;
    }

    uploadError.classList.add('hidden'); // Hide error if file is valid
    file = selectedFile;
    fileNameSpan.textContent = file.name;
    extractButton.disabled = false;
    ocrSlider.disabled = false;
    try {
      await renderPreview(file);
    } catch (err) {
      // Error is already displayed by renderPreview's internal catch blocks.
      // We just need to log it and prevent further execution.
      console.error('Render preview failed:', err);
    }
  } else {
    fileNameSpan.textContent = 'No file chosen';
    extractButton.disabled = true;
    ocrSlider.disabled = true;
    clearPreview();
  }
});

extractButton.addEventListener('click', runExtraction);

ocrSlider.addEventListener('input', () => {
  if (ocrValueSpan) {
    ocrValueSpan.textContent = `${ocrSlider.value}%`;
  }
});

ocrSlider.addEventListener('change', () => {
  // Only re-run if a file is already loaded and processed
  if (file && fileData) {
    runExtraction();
  }
});

tabsContainer.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('tab-button')) {
    const tabName = target.dataset.tab;
    // Fix: Ensure tabName is a string before calling setActiveTab, which requires a string argument.
    if (tabName) {
      setActiveTab(tabName);
    }
  }
});

jsonResultsContainer.addEventListener('click', (e) => {
  if (currentlyEditing) return;
  const target = e.target as HTMLElement;
  const elementWrapper = target.closest(
    '.json-interactive-element',
  ) as HTMLElement;

  if (elementWrapper?.dataset.elementIndex) {
    const index = parseInt(elementWrapper.dataset.elementIndex, 10);
    if (!isNaN(index) && extractedData[index]) {
      const element = extractedData[index];
      drawBoundingBox(element, false); // Draw non-animated box on click
      highlightMarkdownItem(index);
    }
  }
});

jsonResultsContainer.addEventListener('mouseover', (e) => {
  if (currentlyEditing) return;
  const target = e.target as HTMLElement;
  const elementWrapper = target.closest(
    '.json-interactive-element',
  ) as HTMLElement;

  if (elementWrapper?.dataset.elementIndex) {
    const index = parseInt(elementWrapper.dataset.elementIndex, 10);
    if (!isNaN(index) && extractedData[index]) {
      const element = extractedData[index];
      drawBoundingBox(element, true); // Draw animated box on hover
      highlightMarkdownItem(index);
    }
  }
});

jsonResultsContainer.addEventListener('mouseleave', () => {
  if (currentlyEditing) return;
  clearBoundingBoxes();
});

exportButton.addEventListener('click', () => {
  exportDropdown.classList.toggle('hidden');
});

exportCsvButton.addEventListener('click', (e) => {
  e.preventDefault();
  if (extractedData.length > 0) {
    exportAsCsv(extractedData);
  }
  exportDropdown.classList.add('hidden');
});

exportTxtButton.addEventListener('click', (e) => {
  e.preventDefault();
  if (extractedData.length > 0) {
    exportAsTxt(extractedData);
  }
  exportDropdown.classList.add('hidden');
});

// Close dropdown if clicked outside
document.addEventListener('click', (event) => {
  if (
    !exportButton.contains(event.target as Node) &&
    !exportDropdown.contains(event.target as Node)
  ) {
    exportDropdown.classList.add('hidden');
  }
});

previewContainer.addEventListener('mousemove', (event) => {
  handlePreviewMouseMove(event);
});

previewContainer.addEventListener('mouseleave', () => {
  if (currentlyEditing) return;
  clearBoundingBoxes();
  lastHoveredElementIndex = -1;
});

function handleFeedback(isGood: boolean) {
  console.log(
    `Bounding box accuracy feedback: ${
      isGood ? 'Good' : 'Needs Improvement'
    }. This data can be used for model retraining.`,
  );
  feedbackGoodButton.disabled = true;
  feedbackBadButton.disabled = true;
  feedbackThanksSpan.classList.remove('hidden');
}

feedbackGoodButton.addEventListener('click', () => handleFeedback(true));
feedbackBadButton.addEventListener('click', () => handleFeedback(false));

// --- UI Functions ---

function setActiveTab(tabName: string) {
  tabButtons.forEach((button) => {
    // Fix: Cast 'button' to HTMLElement to access the 'dataset' property.
    // This resolves the "Property 'dataset' does not exist on type 'Element'" error,
    // as querySelectorAll returns a list of generic Elements.
    button.classList.toggle(
      'active',
      (button as HTMLElement).dataset.tab === tabName,
    );
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.id === `${tabName}-tab`);
  });
}

/**
 * Renders a preview of the uploaded file (PDF or image).
 * This function is now fully asynchronous and resolves only after the
 * file has been read and the preview is fully rendered, ensuring
 * that page/image dimensions are available before proceeding.
 */
async function renderPreview(file: File): Promise<void> {
  clearPreview();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = async (e) => {
      try {
        const result = e.target?.result as string;
        if (!result) {
          throw new Error('FileReader returned an empty result.');
        }
        const base64Data = result.split(',')[1];
        if (!base64Data) {
          throw new Error('Could not parse base64 data from file.');
        }

        fileData = {
          mimeType: file.type,
          data: base64Data,
        };

        if (file.type === 'application/pdf') {
          const pdf = await pdfjsLib.getDocument({ data: atob(base64Data) })
            .promise;
          for (let i = 1; i <= pdf.numPages; i++) {
            const canvas = document.createElement('canvas');
            canvas.dataset.pageNumber = String(i);
            const page = await pdf.getPage(i);

            // Get viewport at scale 1.0 to store the true, unscaled dimensions.
            const unscaledViewport = page.getViewport({ scale: 1.0 });
            pageDimensions.push({
              width: unscaledViewport.width,
              height: unscaledViewport.height,
            });

            // Use a separate, scaled viewport for high-resolution rendering.
            const renderScale = 1.5;
            const renderViewport = page.getViewport({ scale: renderScale });
            const context = canvas.getContext('2d');
            canvas.height = renderViewport.height;
            canvas.width = renderViewport.width;

            await page.render({
              canvasContext: context,
              viewport: renderViewport,
            }).promise;
            previewContainer.appendChild(canvas);
          }
          resolve(); // Resolve after all PDF pages are rendered
        } else {
          // Image logic
          const imagePreview = document.createElement('img');
          imagePreview.alt = 'Image preview';
          imagePreview.dataset.pageNumber = '1';
          imagePreview.onload = () => {
            pageDimensions.push({
              width: imagePreview.naturalWidth,
              height: imagePreview.naturalHeight,
            });
            previewContainer.appendChild(imagePreview);
            resolve(); // Resolve only after the image is loaded and dimensions are stored
          };
          imagePreview.onerror = () => {
            throw new Error(
              'Could not load the image. It might be corrupted.',
            );
          };
          imagePreview.src = result;
        }
      } catch (error) {
        console.error('Error rendering preview:', error);
        const message =
          error instanceof Error ? error.message : 'An unknown error occurred.';
        uploadError.textContent = `Failed to preview file. ${message}`;
        uploadError.classList.remove('hidden');
        // Reset state fully
        fileUpload.value = '';
        file = null;
        fileData = null;
        fileNameSpan.textContent = 'No file chosen';
        extractButton.disabled = true;
        ocrSlider.disabled = true;
        clearPreview();
        reject(error); // Reject the promise on failure
      }
    };

    reader.onerror = () => {
      console.error('FileReader error.');
      uploadError.textContent = 'An error occurred while reading the file.';
      uploadError.classList.remove('hidden');
      reject(new Error('FileReader error.'));
    };

    reader.readAsDataURL(file);
  });
}

function displayMarkdownResults(elements: any[]) {
  markdownResultsContainer.innerHTML = ''; // Clear previous results
  if (!elements || elements.length === 0) {
    markdownResultsContainer.innerHTML =
      '<p>No structured data was extracted. The document might be empty or in an unsupported format.</p>';
    return;
  }

  elements.forEach((element, index) => {
    const resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.dataset.elementIndex = String(index);

    const header = document.createElement('div');
    header.className = 'result-item-header';
    header.addEventListener('click', () => {
      if (currentlyEditing?.index !== index) {
        drawBoundingBox(element, false);
      }
    });

    const content = document.createElement('div');
    content.className = 'result-item-content';

    const actions = document.createElement('div');
    actions.className = 'result-item-actions';
    actions.dataset.actionsIndex = String(index); // Link actions to the item

    switch (element.type) {
      case 'field':
      case 'checkbox':
      case 'paragraph':
      case 'logo':
      case 'figure':
      case 'marginalia':
      case 'attestation':
        resultItem.classList.add('field-item', `${element.type}-item`);
        content.innerHTML = `
          <span class="result-label">${element.label || element.type}</span>
          <span class="result-value">${element.value || 'N/A'}</span>
        `;
        break;

      case 'field_group':
        resultItem.classList.add('field-group-item');
        const groupTitle = document.createElement('h3');
        groupTitle.textContent = element.label || 'Field Group';
        content.appendChild(groupTitle);

        if (element.fields && element.fields.length > 0) {
          const fieldsList = document.createElement('div');
          fieldsList.className = 'field-group-fields';
          element.fields.forEach(
            (field: { label: string; value: string }) => {
              const fieldDiv = document.createElement('div');
              fieldDiv.className = 'field-item-inner';
              fieldDiv.innerHTML = `
                <span class="result-label">${field.label || 'N/A'}</span>
                <span class="result-value">${field.value || 'N/A'}</span>
              `;
              fieldsList.appendChild(fieldDiv);
            },
          );
          content.appendChild(fieldsList);
        }
        break;

      case 'table':
        resultItem.classList.add('table-item');
        const tableTitle = document.createElement('h3');
        tableTitle.textContent = element.label || 'Extracted Table';
        content.appendChild(tableTitle);

        if (element.table_data && element.table_data.rows) {
          const table = document.createElement('table');
          const thead = document.createElement('thead');
          const headerRow = document.createElement('tr');

          (element.table_data.headers || []).forEach((headerText: string) => {
            const th = document.createElement('th');
            th.textContent = headerText;
            headerRow.appendChild(th);
          });
          thead.appendChild(headerRow);
          table.appendChild(thead);

          const tbody = document.createElement('tbody');
          element.table_data.rows.forEach((rowData: string[]) => {
            const row = document.createElement('tr');
            rowData.forEach((cellData: string) => {
              const td = document.createElement('td');
              td.textContent = cellData;
              row.appendChild(td);
            });
            tbody.appendChild(row);
          });
          table.appendChild(tbody);
          content.appendChild(table);
        } else {
          content.innerHTML += '<p>Table data is empty or malformed.</p>';
        }
        break;

      default:
        return; // Skip unknown types
    }

    header.appendChild(content);
    header.appendChild(actions);
    resultItem.appendChild(header);
    markdownResultsContainer.appendChild(resultItem);

    // After appending, populate the actions for this item
    updateActionButtons(index);
  });
}

function displayJsonResults(data: any) {
  // jsonResultsContainer is the <code> element with id="json-results"
  jsonResultsContainer.innerHTML = ''; // Clear previous content

  // Helper for syntax highlighting a JSON string
  const syntaxHighlight = (jsonString: string) => {
    return jsonString
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(
        /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
        function (match) {
          let cls = 'json-number';
          if (/^"/.test(match)) {
            cls = /:$/.test(match) ? 'json-key' : 'json-string';
          } else if (/true|false/.test(match)) {
            cls = 'json-boolean';
          } else if (/null/.test(match)) {
            cls = 'json-null';
          }
          return `<span class="${cls}">${match}</span>`;
        },
      );
  };

  // If there's no data or it's an error object without extracted_elements
  const elements = data.extracted_elements || data;
  if (!Array.isArray(elements)) {
    const content = syntaxHighlight(JSON.stringify(data, null, 2));
    jsonResultsContainer.innerHTML = content;
    return;
  }

  // Build the final HTML as a string
  let finalHtml = '';
  finalHtml += `{<br>  <span class="json-key">"extracted_elements"</span>: [<br>`;

  elements.forEach((element: any, index: number) => {
    const elementString = JSON.stringify(element, null, 2);
    const highlightedElementString = syntaxHighlight(elementString);

    // Indent the content for proper formatting inside <pre>
    const indentedHtml =
      '    ' + highlightedElementString.replace(/\n/g, '\n    ');

    finalHtml += `<div class="json-interactive-element" data-element-index="${String(
      index,
    )}">${indentedHtml}</div>`;

    if (index < elements.length - 1) {
      finalHtml += ',\n';
    } else {
      finalHtml += '\n';
    }
  });

  finalHtml += '  ]\n}';

  jsonResultsContainer.innerHTML = finalHtml;
}

// Fix: The getCoordinateSystem function returns a nested object. The original code
// incorrectly destructured it, leading to errors. This version correctly
// handles the nested structure and passes the full coordinate system object
// where needed, resolving multiple related type errors.
function drawBoundingBox(
  element: any,
  isAnimated = false,
  isEditable = false,
) {
  if (!isEditable) {
    clearBoundingBoxes();
  }

  // Prioritize using granular line_boxes for a tighter fit,
  // otherwise fall back to the main bounding_box.
  const boxesToDraw =
    element.line_boxes && element.line_boxes.length > 0
      ? element.line_boxes
      : element.bounding_box
        ? [element.bounding_box]
        : [];

  if (boxesToDraw.length === 0 || !element.page) return;

  const previewElement = document.querySelector(
    `#preview-container [data-page-number='${element.page}']`,
  ) as HTMLElement;

  if (!previewElement) return;

  const coordSystem = getCoordinateSystem(previewElement, element.page);
  if (!coordSystem) return;

  // --- PRECISE SCROLL LOGIC ---
  if (!isEditable) {
    // Only scroll if not in edit mode
    const firstBox = boxesToDraw[0];
    const pageDim = pageDimensions[element.page - 1];
    const boxY =
      firstBox.top * pageDim.height * coordSystem.coords.scale +
      coordSystem.coords.offsetY;
    const boxHeight =
      (firstBox.bottom - firstBox.top) *
      pageDim.height *
      coordSystem.coords.scale;
    const targetScrollTop =
      coordSystem.relativeTop +
      boxY +
      boxHeight / 2 -
      previewContainer.clientHeight / 2;
    previewContainer.scrollTo({
      top: targetScrollTop,
      behavior: 'smooth',
    });
  }
  // --- END PRECISE SCROLL LOGIC ---

  // Draw a div for each box.
  boxesToDraw.forEach((box: any, boxIndex: number) => {
    if (!box) return;

    const boundingBoxDiv = document.createElement('div');
    boundingBoxDiv.className = 'bounding-box';
    if (isAnimated) {
      boundingBoxDiv.classList.add('bounding-box-animated');
    }

    if (element.type === 'figure' || element.type === 'logo') {
      boundingBoxDiv.classList.add('bounding-box-visual');
    } else {
      boundingBoxDiv.classList.add('bounding-box-text');
    }

    const {
      page: { width: contentWidth, height: contentHeight },
      pixels: { left, top, width, height },
    } = normalizedToPixels(box, element.page, coordSystem);

    boundingBoxDiv.style.left = `${left}px`;
    boundingBoxDiv.style.top = `${top}px`;
    boundingBoxDiv.style.width = `${width}px`;
    boundingBoxDiv.style.height = `${height}px`;

    if (isEditable) {
      boundingBoxDiv.classList.add('editable');
      // Store reference to the original box data for updating
      // We use a property on the element to avoid globals
      (boundingBoxDiv as any).originalBoxData = box;
      (boundingBoxDiv as any).boxIndex = boxIndex;
      makeBoxEditable(boundingBoxDiv);
    }

    previewContainer.appendChild(boundingBoxDiv);
  });
}

function clearBoundingBoxes() {
  const existingBoxes = document.querySelectorAll('.bounding-box');
  existingBoxes.forEach((box) => box.remove());

  document
    .querySelectorAll('.result-item.highlighted')
    .forEach((item) => item.classList.remove('highlighted'));
}

function clearResults() {
  markdownResultsContainer.innerHTML = '';
  jsonResultsContainer.textContent = '';
  extractedData = [];
  exportButton.disabled = true;
  feedbackContainer?.classList.add('hidden');
}

function clearPreview() {
  previewContainer.innerHTML = '';
  fileData = null;
  pageDimensions = [];
  clearBoundingBoxes();
  clearResults();
  setActiveTab('schema');
  uploadError.classList.add('hidden');
}

function highlightMarkdownItem(index: number) {
  const resultItem = markdownResultsContainer.querySelector(
    `[data-element-index='${index}']`,
  );
  if (resultItem) {
    document
      .querySelectorAll('.result-item.highlighted')
      .forEach((item) => item.classList.remove('highlighted'));
    resultItem.classList.add('highlighted');
    resultItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function handlePreviewMouseMove(event: MouseEvent) {
  if (
    isThrottled ||
    !extractedData ||
    extractedData.length === 0 ||
    currentlyEditing
  )
    return;
  isThrottled = true;
  setTimeout(() => (isThrottled = false), 50); // throttle calls

  const target = event.target as HTMLElement;
  // Clear highlights if cursor is not over a page (e.g., in the padding)
  if (!target || !['CANVAS', 'IMG'].includes(target.tagName)) {
    if (lastHoveredElementIndex !== -1) {
      clearBoundingBoxes();
      lastHoveredElementIndex = -1;
    }
    return;
  }

  const pageEl = target;
  const pageNum = parseInt(pageEl.dataset.pageNumber, 10);
  const pageDim = pageDimensions[pageNum - 1];
  if (!pageDim) return;

  const {
    page: { width: contentWidth, height: contentHeight },
    coords: { scale, offsetX, offsetY },
  } = getCoordinateSystem(pageEl, pageNum);

  // event.offsetX/Y are relative to the target element (the canvas/image)
  const normalizedX = (event.offsetX - offsetX) / (contentWidth * scale);
  const normalizedY = (event.offsetY - offsetY) / (contentHeight * scale);

  let foundElementIndex = -1;
  // Iterate backwards to find the topmost element (last in the DOM order)
  for (let i = extractedData.length - 1; i >= 0; i--) {
    const element = extractedData[i];
    if (element.page !== pageNum) continue;

    const boxesToCheck =
      element.line_boxes && element.line_boxes.length > 0
        ? element.line_boxes
        : element.bounding_box
          ? [element.bounding_box]
          : [];

    for (const box of boxesToCheck) {
      if (
        box &&
        normalizedX >= box.left &&
        normalizedX <= box.right &&
        normalizedY >= box.top &&
        normalizedY <= box.bottom
      ) {
        foundElementIndex = i;
        break;
      }
    }
    if (foundElementIndex !== -1) break;
  }

  if (foundElementIndex !== lastHoveredElementIndex) {
    clearBoundingBoxes();
    if (foundElementIndex !== -1) {
      const element = extractedData[foundElementIndex];
      drawBoundingBox(element, false);
      highlightMarkdownItem(foundElementIndex);
    }
    lastHoveredElementIndex = foundElementIndex;
  }
}

// --- Bounding Box Editor Functions ---

function enterEditMode(index: number) {
  if (currentlyEditing) {
    // If trying to edit the same one, do nothing.
    if (currentlyEditing.index === index) return;
    // Otherwise, cancel the previous edit.
    exitEditMode(false);
  }

  const element = extractedData[index];
  if (!element) return;

  currentlyEditing = {
    index,
    // Deep copy for restoration on cancel
    originalElement: JSON.parse(JSON.stringify(element)),
  };

  clearBoundingBoxes(); // Clear any hover boxes
  drawBoundingBox(element, false, true); // Draw the editable boxes
  updateActionButtons(index, true); // Show save/cancel

  // Highlight the item being edited
  const resultItem = markdownResultsContainer.querySelector(
    `[data-element-index='${index}']`,
  );
  resultItem?.classList.add('is-editing');
  resultItem?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function exitEditMode(shouldSave: boolean) {
  if (!currentlyEditing) return;

  const { index, originalElement } = currentlyEditing;

  if (shouldSave) {
    updateElementFromEditableBoxes(index);
    // After saving, the current state is the new "original" state
    // so we just clear the edit session.
  } else {
    // Restore the original data on cancel
    extractedData[index] = originalElement;
  }

  currentlyEditing = null;

  // UI cleanup
  const resultItem = markdownResultsContainer.querySelector(
    `[data-element-index='${index}']`,
  );
  resultItem?.classList.remove('is-editing');

  updateActionButtons(index, false); // Revert to edit button
  clearBoundingBoxes(); // Remove editable boxes
  displayJsonResults({ extracted_elements: extractedData }); // Refresh JSON view
}

function updateActionButtons(index: number, isEditing = false) {
  const actionsContainer = markdownResultsContainer.querySelector(
    `[data-actions-index='${index}']`,
  );
  if (!actionsContainer) return;

  actionsContainer.innerHTML = ''; // Clear existing buttons

  const createBtn = (id: 'edit' | 'save' | 'cancel', onClick: () => void) => {
    const btn = document.createElement('button');
    btn.className = `result-action-btn ${id}-btn`;
    const icon = document.getElementById(`icon-${id}`).cloneNode(true);
    btn.appendChild(icon);
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent header click event
      onClick();
    });
    return btn;
  };

  if (isEditing) {
    const saveButton = createBtn('save', () => exitEditMode(true));
    const cancelButton = createBtn('cancel', () => exitEditMode(false));
    actionsContainer.appendChild(saveButton);
    actionsContainer.appendChild(cancelButton);
  } else {
    const editButton = createBtn('edit', () => enterEditMode(index));
    actionsContainer.appendChild(editButton);
  }
}

function makeBoxEditable(boxDiv: HTMLElement) {
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  handles.forEach((handleName) => {
    const handle = document.createElement('div');
    handle.className = `resize-handle ${handleName}`;
    handle.addEventListener('mousedown', (e) =>
      initResize(e, boxDiv, handleName),
    );
    boxDiv.appendChild(handle);
  });
  boxDiv.addEventListener('mousedown', (e) => initDrag(e, boxDiv));
}

function initDrag(e: MouseEvent, boxDiv: HTMLElement) {
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startY = e.clientY;
  const startLeft = boxDiv.offsetLeft;
  const startTop = boxDiv.offsetTop;

  const doDrag = (moveEvent: MouseEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;
    boxDiv.style.left = `${startLeft + dx}px`;
    boxDiv.style.top = `${startTop + dy}px`;
  };

  const stopDrag = () => {
    document.removeEventListener('mousemove', doDrag);
    document.removeEventListener('mouseup', stopDrag);
  };

  document.addEventListener('mousemove', doDrag);
  document.addEventListener('mouseup', stopDrag);
}

function initResize(e: MouseEvent, boxDiv: HTMLElement, handle: string) {
  e.preventDefault();
  e.stopPropagation();

  const startX = e.clientX;
  const startY = e.clientY;
  const startWidth = boxDiv.offsetWidth;
  const startHeight = boxDiv.offsetHeight;
  const startLeft = boxDiv.offsetLeft;
  const startTop = boxDiv.offsetTop;

  const doResize = (moveEvent: MouseEvent) => {
    const dx = moveEvent.clientX - startX;
    const dy = moveEvent.clientY - startY;

    if (handle.includes('e')) {
      boxDiv.style.width = `${startWidth + dx}px`;
    }
    if (handle.includes('w')) {
      boxDiv.style.width = `${startWidth - dx}px`;
      boxDiv.style.left = `${startLeft + dx}px`;
    }
    if (handle.includes('s')) {
      boxDiv.style.height = `${startHeight + dy}px`;
    }
    if (handle.includes('n')) {
      boxDiv.style.height = `${startHeight - dy}px`;
      boxDiv.style.top = `${startTop + dy}px`;
    }
  };

  const stopResize = () => {
    document.removeEventListener('mousemove', doResize);
    document.removeEventListener('mouseup', stopResize);
  };

  document.addEventListener('mousemove', doResize);
  document.addEventListener('mouseup', stopResize);
}

function updateElementFromEditableBoxes(elementIndex: number) {
  const element = extractedData[elementIndex];
  if (!element) return;

  const editableBoxes = document.querySelectorAll(
    '.bounding-box.editable',
  ) as NodeListOf<HTMLElement>;

  editableBoxes.forEach((boxDiv) => {
    const boxIndex = (boxDiv as any).boxIndex;
    const originalBoxRef = (boxDiv as any).originalBoxData;

    if (originalBoxRef === undefined) return;

    const newPixelBounds = {
      left: boxDiv.offsetLeft,
      top: boxDiv.offsetTop,
      width: boxDiv.offsetWidth,
      height: boxDiv.offsetHeight,
    };

    const newNormalizedBox = pixelsToNormalized(newPixelBounds, element.page);

    // Update the correct box in the element data
    if (
      element.line_boxes &&
      element.line_boxes.length > 0 &&
      boxIndex !== undefined
    ) {
      element.line_boxes[boxIndex] = newNormalizedBox;
    } else if (element.bounding_box) {
      element.bounding_box = newNormalizedBox;
    }
  });
}

// --- Coordinate Conversion Utilities ---

/**
 * Calculates the scaling and offset parameters for a given page element.
 * Uses high-precision `getBoundingClientRect` for pixel-perfect accuracy.
 */
function getCoordinateSystem(previewElement: HTMLElement, pageNum: number) {
  const pageDim = pageDimensions[pageNum - 1];
  if (!pageDim) return null;

  // Use getBoundingClientRect for more precise, floating-point dimensions.
  const elementRect = previewElement.getBoundingClientRect();
  const displayWidth = elementRect.width;
  const displayHeight = elementRect.height;

  const { width: contentWidth, height: contentHeight } = pageDim;

  const displayAspectRatio = displayWidth / displayHeight;
  const contentAspectRatio = contentWidth / contentHeight;

  let scale: number;
  let offsetX = 0;
  let offsetY = 0;

  if (displayAspectRatio > contentAspectRatio) {
    // Display is wider than content (letterboxed)
    scale = displayHeight / contentHeight;
    offsetX = (displayWidth - contentWidth * scale) / 2;
  } else {
    // Display is taller than content (pillarboxed)
    scale = displayWidth / contentWidth;
    offsetY = (displayHeight - contentHeight * scale) / 2;
  }

  const containerRect = previewContainer.getBoundingClientRect();
  const relativeTop =
    elementRect.top - containerRect.top + previewContainer.scrollTop;
  const relativeLeft =
    elementRect.left - containerRect.left + previewContainer.scrollLeft;

  return {
    page: { width: contentWidth, height: contentHeight },
    display: { width: displayWidth, height: displayHeight },
    coords: { scale, offsetX, offsetY },
    relativeTop,
    relativeLeft,
  };
}

/**
 * Converts normalized coordinates to absolute pixel values for display.
 */
function normalizedToPixels(
  box: any,
  pageNum: number,
  coordSystem: ReturnType<typeof getCoordinateSystem>,
) {
  const {
    page: { width: contentWidth, height: contentHeight },
    coords: { scale, offsetX, offsetY },
    relativeTop,
    relativeLeft,
  } = coordSystem;

  const left = relativeLeft + box.left * contentWidth * scale + offsetX;
  const top = relativeTop + box.top * contentHeight * scale + offsetY;
  const width = (box.right - box.left) * contentWidth * scale;
  const height = (box.bottom - box.top) * contentHeight * scale;

  return {
    page: { width: contentWidth, height: contentHeight },
    pixels: { left, top, width, height },
  };
}

/**
 * Converts absolute pixel values back to normalized coordinates.
 */
function pixelsToNormalized(pixelBounds: any, pageNum: number) {
  const previewElement = document.querySelector(
    `#preview-container [data-page-number='${pageNum}']`,
  ) as HTMLElement;
  if (!previewElement) return null;

  const {
    page: { width: contentWidth, height: contentHeight },
    coords: { scale, offsetX, offsetY },
    relativeTop,
    relativeLeft,
  } = getCoordinateSystem(previewElement, pageNum);

  const absoluteLeft = pixelBounds.left - relativeLeft;
  const absoluteTop = pixelBounds.top - relativeTop;

  const norm = {
    left: (absoluteLeft - offsetX) / (contentWidth * scale),
    top: (absoluteTop - offsetY) / (contentHeight * scale),
    right:
      (absoluteLeft + pixelBounds.width - offsetX) / (contentWidth * scale),
    bottom:
      (absoluteTop + pixelBounds.height - offsetY) / (contentHeight * scale),
  };
  return norm;
}

// --- Export Functions ---
// Note: These are simplified implementations.
function exportAsCsv(data: any[]) {
  const headers = ['type', 'label', 'value', 'page'];
  let csvRows = [headers.join(',')];

  data.forEach((element) => {
    if (element.type === 'field_group' && element.fields) {
      element.fields.forEach((field: { label: string; value: string }) => {
        const row = [
          'field',
          `"${element.label} - ${field.label}"`,
          `"${field.value}"`,
          element.page,
        ].join(',');
        csvRows.push(row);
      });
    } else if (element.type === 'table' && element.table_data) {
      const tableHeader = element.table_data.headers.join(' | ');
      element.table_data.rows.forEach((tableRow: string[]) => {
        const row = [
          'table_row',
          `"${element.label} (${tableHeader})"`,
          `"${tableRow.join(' | ')}"`,
          element.page,
        ].join(',');
        csvRows.push(row);
      });
    } else {
      const row = [
        element.type,
        `"${element.label || ''}"`,
        `"${element.value || ''}"`,
        element.page,
      ].join(',');
      csvRows.push(row);
    }
  });

  const csvContent = csvRows.join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.setAttribute('href', url);
  link.setAttribute('download', `${file?.name || 'export'}.csv`);
  link.style.visibility = 'hidden';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function exportAsTxt(data: any[]) {
  let textContent = '';
  const docTitle = `Extraction Results for: ${file?.name || 'document'}\n`;
  textContent += docTitle;
  textContent += '='.repeat(docTitle.length) + '\n\n';

  data.forEach((element) => {
    textContent += `[${element.type.toUpperCase()}] - Page ${element.page}\n`;
    if (element.label) {
      textContent += `Label: ${element.label}\n`;
    }
    if (element.value) {
      textContent += `Value: ${element.value}\n`;
    }
    if (element.type === 'field_group' && element.fields) {
      element.fields.forEach((field: { label: string; value: string }) => {
        textContent += `  - ${field.label}: ${field.value}\n`;
      });
    }
    if (element.type === 'table' && element.table_data) {
      textContent += 'Table Data:\n';
      textContent += `  Headers: ${element.table_data.headers.join(' | ')}\n`;
      element.table_data.rows.forEach((row: string[]) => {
        textContent += `  Row: ${row.join(' | ')}\n`;
      });
    }
    textContent += '---\n\n';
  });

  const blob = new Blob([textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', `${file?.name || 'export'}.txt`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Renders a visual representation of the JSON schema in the UI.
 */
function displaySchema() {
  const schemaContainer = document.getElementById('schema-tab');
  schemaContainer.innerHTML = `
    <div class="schema-quick-start">
      <div class="schema-tabs">
        <button class="schema-tab-button active">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75l-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z"></path></svg>
          Smart Suggestion
        </button>
        <button class="schema-tab-button">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>
          Prompt to Schema
        </button>
      </div>
      <div class="schema-fields">
        <h4>Schema for 'extracted_elements'</h4>
        <div class="schema-item">
          <span>extracted_elements</span>
          <span class="schema-type array">ARRAY</span>
        </div>
        <div class="schema-item nested">
          <span>(item)</span>
          <span class="schema-type object">OBJECT</span>
        </div>
        <div class="schema-item nested-2">
          <span>type</span>
          <span class="schema-type string">STRING</span>
        </div>
        <div class="schema-item nested-2">
          <span>label</span>
          <span class="schema-type string">STRING</span>
        </div>
         <div class="schema-item nested-2">
          <span>value</span>
          <span class="schema-type string">STRING</span>
        </div>
        <div class="schema-item nested-2">
          <span>page</span>
          <span class="schema-type integer">INTEGER</span>
        </div>
         <div class="schema-item nested-2">
          <span>bounding_box</span>
          <span class="schema-type object">OBJECT</span>
        </div>
      </div>
    </div>
  `;
}

// Display the schema on initial load
displaySchema();